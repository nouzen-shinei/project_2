// Feature: device-push-fanout-migration, Stage 3 (Task 12.1, Part B) — client
// single-device push migration. `sendNotificationToDeviceDetailed` routes a
// single-device push through the backend Fanout_Endpoint under the
// Fanout_Feature_Flag, while presence-to-self stays local.
//
// With Firestore, auth, the internal-token bridge, and fetch fully mocked (no
// real network / Firestore), mirroring `deviceFanoutClientDelegation.test.ts`,
// this suite proves:
//
//   - flag ON, cross-user target → POST /notifications/fanout with the
//     `deviceId` field, NO cross-user `getDocs`, and the counts-only server
//     result mapped to `{ delivered, deliverySource: 'push', pushChannel }`
//     (mobile vs web) (Req 4.3, 4.4, 7.3, 9.1);
//   - flag ON, presence-to-self (signed-in user's own current web device) →
//     delivers LOCALLY (a local notification) with NO endpoint call and NO device
//     read, reporting `{ delivered: true, deliverySource: 'presence' }` (Req 4.1);
//   - flag ON, failed backend call → `{ delivered: false, deliverySource:
//     'unknown' }` (non-throwing contract preserved), still no device read;
//   - flag OFF → the legacy local single-device path runs UNCHANGED and never
//     hits the Fanout_Endpoint (Req 9.2).

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the service is imported.
// ---------------------------------------------------------------------------

const mockSetDoc = jest.fn(async (..._args: any[]) => {});
const mockUpdateDoc = jest.fn(async (..._args: any[]) => {});
const mockAddDoc = jest.fn(async (..._args: any[]) => ({ id: 'mock-doc' }));
const mockDeleteDoc = jest.fn(async (..._args: any[]) => {});
const mockGetDoc = jest.fn(async (..._args: any[]): Promise<any> => ({ exists: () => false, data: () => ({}) }));
// getDocs is the recipient `user_devices` read performed by `getUserDevices`.
// Asserting it is NEVER called under the flag proves the no-cross-user-read invariant.
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

const mockGetCachedSelectedTenant = jest.fn(async (): Promise<string | null> => null);
jest.mock('@/services/tenantService', () => ({
  __esModule: true,
  tenantService: {
    getCachedSelectedTenant: (...args: any[]) => mockGetCachedSelectedTenant(...(args as [])),
    getActiveMembershipsForTenant: jest.fn(async () => []),
    getCachedMemberships: jest.fn(async () => []),
    getMembershipsForUser: jest.fn(async () => []),
    cacheMemberships: jest.fn(async () => {}),
  },
}));

// Remaining module-scope imports — stubbed so importing the service does not pull
// in real native / firebase dependencies (mirrors deviceFanoutClientDelegation.test.ts).
jest.mock('@/lib/expoProjectId', () => ({ __esModule: true, resolveExpoProjectId: jest.fn(() => 'project-id') }));
jest.mock('@/lib/notificationChannels', () => ({ __esModule: true, resolveNotificationChannelId: jest.fn(() => 'default') }));
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
const FLAG = 'EXPO_PUBLIC_SERVER_FANOUT_ENABLED';

/** A counts-only Fanout_Result body, as `serializeFanoutResponse` returns. */
function serverCounts(overrides: Partial<DeviceNotificationFanoutResult> = {}): DeviceNotificationFanoutResult {
  return {
    success: 1,
    failed: 0,
    deliverableDeviceCount: 1,
    onlineDeliverableCount: 1,
    presenceDeliveredCount: 0,
    pushAcceptedCount: 1,
    mobilePushAcceptedCount: 1,
    webPushAcceptedCount: 0,
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

const PUSH_NOTIFICATION = {
  title: 'New message',
  body: 'Hey there',
  data: { type: 'chat_message', senderEmail: 'sender@example.com' },
};

let fetchMock: jest.Mock;

/** The single `/notifications/fanout` call (if any) made during the test. */
function fanoutCall(): [string, any] | undefined {
  return fetchMock.mock.calls.find(([url]) => String(url).endsWith('/notifications/fanout')) as
    | [string, any]
    | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPreferredBackendBaseUrl.mockReturnValue(BASE_URL);
  mockGetToken.mockResolvedValue('internal-token-abc');
  mockForceRefresh.mockResolvedValue('internal-token-refreshed');
  mockGetCachedSelectedTenant.mockResolvedValue(null);
  fetchMock = jest.fn(async () => okResponse(serverCounts()));
  (global as any).fetch = fetchMock;
  runtime.currentUserEmail = null;
  runtime.currentDeviceId = null;
  runtime.lastKnownNotificationsEnabled = true;
  delete process.env[FLAG];
});

afterAll(() => {
  delete process.env[FLAG];
});

// ---------------------------------------------------------------------------
// Flag ON — single-device push delegated to the Fanout_Endpoint
// ---------------------------------------------------------------------------

describe('sendNotificationToDeviceDetailed — single-device Server_Fanout (flag ON)', () => {
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });

  it('POSTs /notifications/fanout with the deviceId target and maps mobile counts, with no cross-user device read', async () => {
    fetchMock.mockResolvedValue(
      okResponse(serverCounts({ pushAcceptedCount: 1, mobilePushAcceptedCount: 1, webPushAcceptedCount: 0 }))
    );

    const result = await runtime.sendNotificationToDeviceDetailed(
      'device-9',
      RECIPIENT,
      PUSH_NOTIFICATION,
      undefined,
      { tenantId: TENANT_ID }
    );

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
    // Body matches the backend `fanoutPayloadSchema`, carrying the single-device `deviceId`.
    expect(JSON.parse(init.body)).toEqual({
      tenantId: TENANT_ID,
      recipientEmail: RECIPIENT,
      notification: {
        title: PUSH_NOTIFICATION.title,
        body: PUSH_NOTIFICATION.body,
        data: PUSH_NOTIFICATION.data,
      },
      onlineOnly: false,
      deviceId: 'device-9',
    });

    // CRITICAL invariant: the client never reads the recipient's user_devices tree.
    expect(mockGetDocs).not.toHaveBeenCalled();

    // Counts-only server result mapped back to the per-device attempt result.
    expect(result).toEqual({ delivered: true, deliverySource: 'push', pushChannel: 'mobile_push' });
  });

  it('maps web-push counts to pushChannel web_push', async () => {
    fetchMock.mockResolvedValue(
      okResponse(serverCounts({ pushAcceptedCount: 1, mobilePushAcceptedCount: 0, webPushAcceptedCount: 1 }))
    );

    const result = await runtime.sendNotificationToDeviceDetailed(
      'device-web',
      RECIPIENT,
      PUSH_NOTIFICATION,
      undefined,
      { tenantId: TENANT_ID }
    );

    expect(result).toEqual({ delivered: true, deliverySource: 'push', pushChannel: 'web_push' });
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('reports not-delivered with no channel when the server accepted no push', async () => {
    fetchMock.mockResolvedValue(
      okResponse(serverCounts({ success: 0, pushAcceptedCount: 0, mobilePushAcceptedCount: 0, webPushAcceptedCount: 0, failed: 1 }))
    );

    const result = await runtime.sendNotificationToDeviceDetailed(
      'device-9',
      RECIPIENT,
      PUSH_NOTIFICATION,
      undefined,
      { tenantId: TENANT_ID }
    );

    expect(result).toEqual({ delivered: false, deliverySource: 'push', pushChannel: undefined });
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('is non-throwing: returns { delivered: false, deliverySource: unknown } when the backend call fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: jest.fn(async () => 'server error') } as any);

    const result = await runtime.sendNotificationToDeviceDetailed(
      'device-9',
      RECIPIENT,
      PUSH_NOTIFICATION,
      undefined,
      { tenantId: TENANT_ID }
    );

    expect(fanoutCall()).toBeDefined();
    expect(result).toEqual({ delivered: false, deliverySource: 'unknown' });
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('resolves the tenant from the cached selected tenant when no option is supplied, still without a device read', async () => {
    mockGetCachedSelectedTenant.mockResolvedValue(TENANT_ID);
    fetchMock.mockResolvedValue(okResponse(serverCounts()));

    await runtime.sendNotificationToDeviceDetailed('device-9', RECIPIENT, PUSH_NOTIFICATION);

    const call = fanoutCall();
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body).tenantId).toBe(TENANT_ID);
    expect(JSON.parse(call![1].body).deviceId).toBe('device-9');
    expect(mockGetDocs).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Flag ON — presence-to-self stays LOCAL
// ---------------------------------------------------------------------------

describe('sendNotificationToDeviceDetailed — presence-to-self (flag ON)', () => {
  beforeEach(() => {
    process.env[FLAG] = 'true';
    runtime.currentUserEmail = SELF;
    runtime.currentDeviceId = 'current-device-1';
  });

  it('delivers a LOCAL notification to the current web device with no endpoint call and no device read', async () => {
    const result = await runtime.sendNotificationToDeviceDetailed(
      'current-device-1',
      SELF,
      { title: 'Quote', body: 'Carpe diem', data: { type: 'daily_quote' } },
      undefined,
      { tenantId: TENANT_ID }
    );

    // Presence delivered locally — no server push, no device read.
    expect(mockSendLocalNotification).toHaveBeenCalledTimes(1);
    expect(fanoutCall()).toBeUndefined();
    expect(mockGetDocs).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: true, deliverySource: 'presence' });
  });

  it('delegates to the endpoint (no local presence) when targeting a DIFFERENT device of the signed-in user', async () => {
    const result = await runtime.sendNotificationToDeviceDetailed(
      'other-device-2',
      SELF,
      PUSH_NOTIFICATION,
      undefined,
      { tenantId: TENANT_ID }
    );

    // A non-current device is delivered server-side, not via local presence.
    expect(mockSendLocalNotification).not.toHaveBeenCalled();
    expect(fanoutCall()).toBeDefined();
    expect(JSON.parse(fanoutCall()![1].body).deviceId).toBe('other-device-2');
    expect(mockGetDocs).not.toHaveBeenCalled();
    expect(result.deliverySource).toBe('push');
  });
});

// ---------------------------------------------------------------------------
// Flag OFF — legacy local single-device path runs UNCHANGED
// ---------------------------------------------------------------------------

describe('sendNotificationToDeviceDetailed — legacy local path (flag OFF)', () => {
  beforeEach(() => {
    process.env[FLAG] = 'false';
    runtime.currentUserEmail = SELF;
    runtime.currentDeviceId = 'legacy-device';
  });

  it('runs the legacy local path with a device override and never calls the Fanout_Endpoint', async () => {
    const deviceOverride = {
      deviceId: 'legacy-device',
      deviceType: 'web',
      isOnline: true,
      tenantIds: [TENANT_ID],
      webPushSubscription: { endpoint: 'https://push.example/legacy', keys: { p256dh: 'a', auth: 'b' } },
    };

    const result = await runtime.sendNotificationToDeviceDetailed(
      'legacy-device',
      SELF,
      { title: 'Hi', body: 'There', data: { tenantId: TENANT_ID } },
      deviceOverride,
      { tenantId: TENANT_ID }
    );

    // No delegation to the Server_Fanout endpoint.
    expect(fanoutCall()).toBeUndefined();
    // Legacy current-web-device delivery is local presence.
    expect(mockSendLocalNotification).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: true, deliverySource: 'presence' });
  });
});
