// Feature: device-push-fanout-migration — client delegation of
// `sendNotificationToUser` push to the backend Fanout_Endpoint.
//
// These tests prove the client/server delivery boundary, with Firestore, auth,
// the internal-token bridge, and fetch fully mocked (no real network /
// Firestore), mirroring the mocking style in
// `deviceTrackingForceLogoutAll.test.ts`:
//
//   - push resolution/delivery is delegated to `POST /notifications/fanout`
//     (via the existing `sendPushViaBackend` bridge) and the client performs NO
//     recipient `user_devices` read (getDocs is never called) (Req 4.3, 4.4, 9.1);
//   - the `DeviceNotificationFanoutResult` contract (the exact ten numeric fields)
//     is preserved (Req 6.1, 9.5);
//   - Presence_Delivery to the signed-in user's OWN current device uses only local
//     state — a local notification, and STILL no recipient device read (Req 4.1).

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the service is imported.
// ---------------------------------------------------------------------------

const mockSetDoc = jest.fn(async (..._args: any[]) => {});
const mockUpdateDoc = jest.fn(async (..._args: any[]) => {});
const mockAddDoc = jest.fn(async (..._args: any[]) => ({ id: 'mock-doc' }));
const mockDeleteDoc = jest.fn(async (..._args: any[]) => {});
const mockGetDoc = jest.fn(async (..._args: any[]): Promise<any> => ({ exists: () => false, data: () => ({}) }));
// getDocs is the recipient `user_devices` read performed by `getUserDevices`.
// Asserting it is (not) called is how we prove the client/server read boundary.
const mockGetDocs = jest.fn(async (..._args: any[]): Promise<any> => ({
  forEach: (_cb: (doc: any) => void) => {},
  docs: [],
  empty: true,
  size: 0,
}));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  doc: (_db: unknown, ...segments: string[]) => ({ __type: 'doc', path: segments.join('/') }),
  collection: (_db: unknown, ...segments: string[]) => ({ __type: 'collection', path: segments.join('/') }),
  query: (...args: unknown[]) => ({ __type: 'query', args }),
  where: (field: string, op: string, value: unknown) => ({ __type: 'where', field, op, value }),
  orderBy: (...args: unknown[]) => ({ __type: 'orderBy', args }),
  limit: (...args: unknown[]) => ({ __type: 'limit', args }),
  getDoc: (...args: any[]) => mockGetDoc(...args),
  getDocs: (...args: any[]) => mockGetDocs(...args),
  setDoc: (...args: any[]) => mockSetDoc(...args),
  updateDoc: (...args: any[]) => mockUpdateDoc(...args),
  addDoc: (...args: any[]) => mockAddDoc(...args),
  deleteDoc: (...args: any[]) => mockDeleteDoc(...args),
  deleteField: jest.fn(() => '__deleteField__'),
  serverTimestamp: jest.fn(() => '__serverTimestamp__'),
  onSnapshot: jest.fn(() => () => {}),
  Timestamp: class {
    constructor(public _date: Date) {}
    static fromDate(date: Date) {
      return new (this as any)(date);
    }
    toDate() {
      return this._date;
    }
  },
}));

jest.mock('@/config/firebase', () => ({
  __esModule: true,
  firestore: { __mockFirestore: true },
  database: { __mockDatabase: true },
  auth: { currentUser: null },
  storage: { __mockStorage: true },
}));

jest.mock('@/hooks/useAuthUnified', () => ({
  __esModule: true,
  authService: {
    signOut: jest.fn(async () => {}),
    getCurrentUser: jest.fn(() => null),
  },
}));

// Platform.OS === 'web' so the current-device Presence_Delivery branch is
// reachable (it mirrors the Client_Fanout `isCurrentDevice` web branch).
jest.mock('react-native', () => ({
  __esModule: true,
  Platform: { OS: 'web' },
  Dimensions: { get: () => ({ width: 375, height: 812, scale: 2, fontScale: 1 }) },
}));

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

const mockGetToken = jest.fn(async (..._args: any[]): Promise<string | undefined> => 'internal-token-abc');
const mockForceRefresh = jest.fn(async (..._args: any[]): Promise<string | undefined> => 'internal-token-refreshed');
const mockInvalidate = jest.fn();
const mockSetBaseUrl = jest.fn();
const mockGetPreferredBackendBaseUrl = jest.fn((): string | undefined => 'https://api.example.com');

jest.mock('@/services/internalTokenManager', () => ({
  __esModule: true,
  internalTokenManager: {
    getToken: (...args: any[]) => mockGetToken(...args),
    forceRefresh: (...args: any[]) => mockForceRefresh(...args),
    invalidate: (...args: any[]) => mockInvalidate(...args),
    setBaseUrl: (...args: any[]) => mockSetBaseUrl(...args),
  },
}));

jest.mock('@/services/runtimeEndpoints', () => ({
  __esModule: true,
  runtimeEndpoints: {
    getSnapshot: jest.fn(() => ({})),
    getPreferredBackendBaseUrl: () => mockGetPreferredBackendBaseUrl(),
  },
}));

const mockMaybeShowMaintenanceAlertFromRaw = jest.fn();
jest.mock('@/services/maintenanceAlert', () => ({
  __esModule: true,
  maybeShowMaintenanceAlertFromRaw: (...args: any[]) => mockMaybeShowMaintenanceAlertFromRaw(...args),
}));

// notificationService is lazy-required by the service for local presence
// delivery. Mock `sendLocalNotification` so presence is observable without
// pulling in the real module.
const mockSendLocalNotification = jest.fn(async (..._args: any[]) => {});
jest.mock('@/services/notificationService', () => ({
  __esModule: true,
  notificationService: {
    sendLocalNotification: (...args: any[]) => mockSendLocalNotification(...args),
  },
}));

// Remaining module-scope imports — stubbed so importing the service does not pull
// in real native / firebase dependencies (mirrors deviceTrackingRuntime.test.ts).
jest.mock('@/lib/expoProjectId', () => ({ __esModule: true, resolveExpoProjectId: jest.fn(() => 'project-id') }));
jest.mock('@/lib/notificationChannels', () => ({ __esModule: true, resolveNotificationChannelId: jest.fn(() => 'default') }));
jest.mock('@/services/tenantService', () => ({ __esModule: true, tenantService: {} }));
jest.mock('@/services/chatReceiptSync', () => ({
  __esModule: true,
  confirmInboundChatDeliveryFromNotificationData: jest.fn(async () => {}),
  flushPendingInboundChatDeliveryReceipts: jest.fn(async () => {}),
}));
jest.mock('firebase/database', () => ({
  __esModule: true,
  getDatabase: jest.fn(() => ({})),
  ref: jest.fn(() => ({})),
  push: jest.fn(() => ({})),
  onValue: jest.fn(() => () => {}),
  remove: jest.fn(async () => {}),
}));
jest.mock('expo-device', () => ({ __esModule: true, getDeviceTypeAsync: jest.fn(async () => 0), DeviceType: { PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4, UNKNOWN: 0 } }));
jest.mock('expo-notifications', () => ({ __esModule: true, getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })) }));
jest.mock('expo-network', () => ({ __esModule: true, getNetworkStateAsync: jest.fn(async () => ({})) }));
jest.mock('expo-application', () => ({ __esModule: true, nativeApplicationVersion: '1.0.0' }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: {} } }));
jest.mock('expo-localization', () => ({ __esModule: true, getLocales: jest.fn(() => []) }));
jest.mock('expo-location', () => ({ __esModule: true, getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })) }));
jest.mock('expo-image-picker', () => ({ __esModule: true, getCameraPermissionsAsync: jest.fn(async () => ({ status: 'denied' })) }));
jest.mock('expo-audio', () => ({ __esModule: true, getRecordingPermissionsAsync: jest.fn(async () => ({ status: 'denied' })) }));
jest.mock('expo-secure-store', () => ({ __esModule: true, getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => {}) }));
jest.mock('expo-crypto', () => ({ __esModule: true, digestStringAsync: jest.fn(async () => 'digest'), CryptoDigestAlgorithm: { SHA256: 'SHA-256' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) } }));
jest.mock('react-native-device-info', () => ({ __esModule: true, default: { getUniqueId: jest.fn(async () => 'unique-id') } }));
jest.mock('crypto-js/sha256', () => ({ __esModule: true, default: jest.fn(() => ({ toString: () => 'sha256-hash' })) }));

// ---------------------------------------------------------------------------
// Import the service singleton after all mocks are registered.
// ---------------------------------------------------------------------------
import { deviceTrackingService, DeviceNotificationFanoutResult } from '../../services/deviceTrackingService';

const runtime = deviceTrackingService as any;

const RECIPIENT = 'recipient@example.com';
const SELF = 'self@example.com';
const TENANT_ID = 'tenant-abc-123';
const BASE_URL = 'https://api.example.com';

/** The exact ten numeric keys of the DeviceNotificationFanoutResult contract. */
const RESULT_KEYS = [
  'success',
  'failed',
  'deliverableDeviceCount',
  'onlineDeliverableCount',
  'presenceDeliveredCount',
  'pushAcceptedCount',
  'mobilePushAcceptedCount',
  'webPushAcceptedCount',
  'staleWebPushSubscriptionsCleaned',
  'deduplicatedWebPushSubscriptionsCleaned',
].sort();

/** A counts-only Fanout_Result body, as `serializeFanoutResponse` returns. */
function serverCounts(overrides: Partial<DeviceNotificationFanoutResult> = {}): DeviceNotificationFanoutResult {
  return {
    success: 2,
    failed: 0,
    deliverableDeviceCount: 2,
    onlineDeliverableCount: 2,
    presenceDeliveredCount: 0,
    pushAcceptedCount: 2,
    mobilePushAcceptedCount: 1,
    webPushAcceptedCount: 1,
    staleWebPushSubscriptionsCleaned: 0,
    deduplicatedWebPushSubscriptionsCleaned: 0,
    ...overrides,
  };
}

/** A successful fetch Response stand-in returning `bodyJson`. */
function okResponse(bodyJson: unknown) {
  return {
    ok: true,
    status: 200,
    json: jest.fn(async () => bodyJson),
    text: jest.fn(async () => JSON.stringify(bodyJson)),
  } as any;
}

const CHAT_NOTIFICATION = {
  title: 'New message',
  body: 'Hey there',
  data: { type: 'chat_message', senderEmail: 'sender@example.com' },
};

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPreferredBackendBaseUrl.mockReturnValue(BASE_URL);
  mockGetToken.mockResolvedValue('internal-token-abc');
  mockForceRefresh.mockResolvedValue('internal-token-refreshed');
  fetchMock = jest.fn(async () => okResponse(serverCounts()));
  (global as any).fetch = fetchMock;
  // Default: no signed-in current device (so presence never fires unless a test
  // opts in). `lastKnownNotificationsEnabled` defaults to true.
  runtime.currentUserEmail = null;
  runtime.currentDeviceId = null;
  runtime.lastKnownNotificationsEnabled = true;
});

/** The single `/notifications/fanout` call (if any) made during the test. */
function fanoutCall(): [string, any] | undefined {
  return fetchMock.mock.calls.find(([url]) => String(url).endsWith('/notifications/fanout')) as
    | [string, any]
    | undefined;
}

// ---------------------------------------------------------------------------
// Server_Fanout — delegates to the Fanout_Endpoint, no recipient device read
// ---------------------------------------------------------------------------

describe('sendNotificationToUser — Server_Fanout', () => {
  it('delegates push to POST /notifications/fanout with the schema-shaped body and no recipient device read', async () => {
    const result = await deviceTrackingService.sendNotificationToUser(
      RECIPIENT,
      CHAT_NOTIFICATION,
      false,
      { tenantId: TENANT_ID }
    );

    // Delegated to the Fanout_Endpoint via the internal-token bridge.
    const call = fanoutCall();
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe(`${BASE_URL}/notifications/fanout`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        Authorization: 'Bearer internal-token-abc',
      })
    );
    // Body matches the backend `fanoutPayloadSchema`.
    expect(JSON.parse(init.body)).toEqual({
      tenantId: TENANT_ID,
      recipientEmail: RECIPIENT,
      notification: {
        title: CHAT_NOTIFICATION.title,
        body: CHAT_NOTIFICATION.body,
        data: CHAT_NOTIFICATION.data,
      },
      onlineOnly: false,
    });

    // CRITICAL: the client never reads the recipient's user_devices tree.
    expect(mockGetDocs).not.toHaveBeenCalled();

    // Push counts come straight from the server result.
    expect(result.pushAcceptedCount).toBe(2);
    expect(result.mobilePushAcceptedCount).toBe(1);
    expect(result.webPushAcceptedCount).toBe(1);
  });

  it('resolves the tenant from data.tenantId when no tenant option is supplied, still without a device read', async () => {
    await deviceTrackingService.sendNotificationToUser(
      RECIPIENT,
      { title: 'T', body: 'B', data: { type: 'notice_created', tenantId: TENANT_ID } },
      true
    );

    const call = fanoutCall();
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body).tenantId).toBe(TENANT_ID);
    expect(JSON.parse(call![1].body).onlineOnly).toBe(true);
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('reports zeroed push counts (and never reads devices) when the backend call fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: jest.fn(async () => 'server error') } as any);

    const result = await deviceTrackingService.sendNotificationToUser(
      RECIPIENT,
      CHAT_NOTIFICATION,
      false,
      { tenantId: TENANT_ID }
    );

    expect(fanoutCall()).toBeDefined();
    expect(mockGetDocs).not.toHaveBeenCalled();
    expect(result.pushAcceptedCount).toBe(0);
    expect(result.success).toBe(0);
    // Contract shape preserved even on failure.
    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
  });
});

// ---------------------------------------------------------------------------
// Presence_Delivery — signed-in user's own current device, local state only
// ---------------------------------------------------------------------------

describe('sendNotificationToUser — Presence_Delivery to own current device', () => {
  beforeEach(() => {
    runtime.currentUserEmail = SELF;
    runtime.currentDeviceId = 'current-device-1';
  });

  it('delivers a LOCAL notification to the current device using only local state, with no recipient device read', async () => {
    const result = await deviceTrackingService.sendNotificationToUser(
      SELF,
      { title: 'Quote', body: 'Carpe diem', data: { type: 'daily_quote', tenantId: TENANT_ID } },
      true,
      { tenantId: TENANT_ID }
    );

    // Presence delivered locally (no other-user device documents involved).
    expect(mockSendLocalNotification).toHaveBeenCalledTimes(1);
    expect(mockGetDocs).not.toHaveBeenCalled();

    // Presence outcome is merged into the contract.
    expect(result.presenceDeliveredCount).toBe(1);
    // success = server push success (2) + local presence (1).
    expect(result.success).toBe(3);
  });

  it('does NOT deliver local presence when the recipient is a different user', async () => {
    await deviceTrackingService.sendNotificationToUser(
      RECIPIENT,
      CHAT_NOTIFICATION,
      false,
      { tenantId: TENANT_ID }
    );

    expect(mockSendLocalNotification).not.toHaveBeenCalled();
    expect(mockGetDocs).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Contract — the full ten-field result shape is preserved on the server path
// ---------------------------------------------------------------------------

describe('sendNotificationToUser — DeviceNotificationFanoutResult contract', () => {
  it('returns the full ten-field contract of finite numbers via the Server_Fanout', async () => {
    const result = await deviceTrackingService.sendNotificationToUser(
      RECIPIENT,
      CHAT_NOTIFICATION,
      false,
      { tenantId: TENANT_ID }
    );

    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    for (const key of RESULT_KEYS) {
      expect(typeof (result as any)[key]).toBe('number');
      expect(Number.isFinite((result as any)[key])).toBe(true);
    }
  });
});
