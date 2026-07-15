// Feature: device-push-fanout-migration, Stage 3 (Task 12.1, Part A) — client
// migration of the remaining Cross_User_Readers of `user_devices` to the
// server-backed resolution endpoints under the Fanout_Feature_Flag.
//
// This suite proves the read/listing/online-status boundary the migration
// introduces, with Firestore, auth, the internal-token bridge, and fetch fully
// mocked (no real network / Firestore), mirroring the mocking style in
// `deviceFanoutClientDelegation.test.ts`:
//
//   - flag ON:
//       * checkUserOnlineStatus(other) → POST /notifications/online-status,
//         returns its boolean, and performs NO cross-user `getDocs` (Req 7.3, 7.5);
//       * getAllUsersWithDevices(...) → POST /notifications/device-listing,
//         reconstructs the AuthorizedUser[] shape (with profile overlay), and
//         performs NO cross-user `getDocs` (Req 7.3, 7.5);
//       * cross-user getUserDevices(other) → POST /notifications/device-listing
//         (single recipient), returns UserDevice[]-shaped devices, NO cross-user
//         `getDocs` (Req 7.3, 4.4);
//       * self getUserDevices(self) → STILL reads via `getDocs` (Owner_Only_Read,
//         Req 7.4) and never hits an endpoint;
//   - flag OFF: every legacy path reads via `getDocs` and never hits the endpoints
//     (Req 9.2);
//   - `getUserPushTokens` no longer exists on the service — the cross-user token
//     listing was RETIRED (Req 5.4, 7.3).

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the service is imported.
// ---------------------------------------------------------------------------

const mockSetDoc = jest.fn(async (..._args: any[]) => {});
const mockUpdateDoc = jest.fn(async (..._args: any[]) => {});
const mockAddDoc = jest.fn(async (..._args: any[]) => ({ id: 'mock-doc' }));
const mockDeleteDoc = jest.fn(async (..._args: any[]) => {});
const mockGetDoc = jest.fn(async (..._args: any[]): Promise<any> => ({ exists: () => false, data: () => ({}) }));
// getDocs is the recipient `user_devices` read performed by the legacy readers.
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

const mockGetUserProfile = jest.fn(async (_email: string): Promise<any> => null);
const mockGetCurrentUser = jest.fn((): { uid: string; email: string } | null => null);

jest.mock('@/hooks/useAuthUnified', () => ({
  __esModule: true,
  authService: {
    signOut: jest.fn(async () => {}),
    getCurrentUser: (...args: any[]) => mockGetCurrentUser(...(args as [])),
    getUserProfile: (...args: any[]) => mockGetUserProfile(args[0]),
  },
}));

// Platform.OS === 'web' matches the delegation-test convention (self-device
// presence branches are unaffected here).
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

const mockSendLocalNotification = jest.fn(async (..._args: any[]) => {});
jest.mock('@/services/notificationService', () => ({
  __esModule: true,
  notificationService: {
    sendLocalNotification: (...args: any[]) => mockSendLocalNotification(...args),
  },
}));

const mockGetCachedSelectedTenant = jest.fn(async (): Promise<string | null> => null);
const mockGetActiveMembershipsForTenant = jest.fn(async (_tenantId: string): Promise<any[]> => []);
jest.mock('@/services/tenantService', () => ({
  __esModule: true,
  tenantService: {
    getCachedSelectedTenant: (...args: any[]) => mockGetCachedSelectedTenant(...(args as [])),
    getActiveMembershipsForTenant: (...args: any[]) => mockGetActiveMembershipsForTenant(args[0]),
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
import { deviceTrackingService } from '../../services/deviceTrackingService';

const runtime = deviceTrackingService as any;

const SELF = 'self@example.com';
const OTHER = 'other@example.com';
const R1 = 'alice@example.com';
const R2 = 'bob@example.com';
const TENANT_ID = 'tenant-abc-123';
const BASE_URL = 'https://api.example.com';
const FLAG = 'EXPO_PUBLIC_SERVER_FANOUT_ENABLED';

/** A successful fetch Response stand-in returning `bodyJson` (as sendPushViaBackend expects). */
function okResponse(bodyJson: unknown) {
  return {
    ok: true,
    status: 200,
    text: jest.fn(async () => JSON.stringify(bodyJson)),
  } as any;
}

let fetchMock: jest.Mock;

/** The fetch call (if any) whose URL ends with `suffix`. */
function callEndingWith(suffix: string): [string, any] | undefined {
  return fetchMock.mock.calls.find(([url]) => String(url).endsWith(suffix)) as [string, any] | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPreferredBackendBaseUrl.mockReturnValue(BASE_URL);
  mockGetToken.mockResolvedValue('internal-token-abc');
  mockForceRefresh.mockResolvedValue('internal-token-refreshed');
  mockGetUserProfile.mockResolvedValue(null);
  mockGetCurrentUser.mockReturnValue(null);
  mockGetCachedSelectedTenant.mockResolvedValue(null);
  mockGetActiveMembershipsForTenant.mockResolvedValue([]);
  // Default fetch returns an empty device-listing; individual tests override.
  fetchMock = jest.fn(async () => okResponse({ users: [] }));
  (global as any).fetch = fetchMock;
  runtime.currentUserEmail = null;
  runtime.currentDeviceId = null;
  delete process.env[FLAG];
});

afterAll(() => {
  delete process.env[FLAG];
});

// ---------------------------------------------------------------------------
// Flag ON — server-backed resolution, no cross-user device read
// ---------------------------------------------------------------------------

describe('Cross_User_Readers — Server-backed resolution (flag ON)', () => {
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });

  it('checkUserOnlineStatus(other) POSTs /notifications/online-status, returns its boolean, and never reads devices', async () => {
    mockGetCachedSelectedTenant.mockResolvedValue(TENANT_ID);
    fetchMock.mockResolvedValue(okResponse({ online: true }));

    const online = await deviceTrackingService.checkUserOnlineStatus(OTHER);

    const call = callEndingWith('/notifications/online-status');
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe(`${BASE_URL}/notifications/online-status`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer internal-token-abc' })
    );
    expect(JSON.parse(init.body)).toEqual({ tenantId: TENANT_ID, recipientEmail: OTHER });

    // The boolean is surfaced verbatim, and NO cross-user device read occurred.
    expect(online).toBe(true);
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('checkUserOnlineStatus(other) returns false (non-throwing) when the backend call fails', async () => {
    mockGetCachedSelectedTenant.mockResolvedValue(TENANT_ID);
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: jest.fn(async () => 'err') } as any);

    const online = await deviceTrackingService.checkUserOnlineStatus(OTHER);

    expect(callEndingWith('/notifications/online-status')).toBeDefined();
    expect(online).toBe(false);
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('getUserDevices(other) POSTs /notifications/device-listing (single recipient) and returns the devices without a cross-user read', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        users: [
          {
            email: OTHER,
            devices: [
              { deviceId: 'd1', isOnline: true, deviceName: 'Phone' },
              { deviceId: 'd2', isOnline: false, deviceName: 'Laptop' },
            ],
            isOnline: true,
            totalDevices: 2,
            tenantIds: [TENANT_ID],
          },
        ],
      })
    );

    const devices = await deviceTrackingService.getUserDevices(OTHER, { tenantId: TENANT_ID });

    const call = callEndingWith('/notifications/device-listing');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      tenantId: TENANT_ID,
      recipientEmails: [OTHER],
      includeCurrentUser: true,
    });

    expect(devices.map((d) => d.deviceId)).toEqual(['d1', 'd2']);
    // CRITICAL: the client never reads the recipient's user_devices tree.
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('getAllUsersWithDevices(...) POSTs /notifications/device-listing, overlays role/displayName, and never reads devices', async () => {
    mockGetUserProfile.mockImplementation(async (email: string) =>
      email === R1 ? { email: R1, role: 'admin', displayName: 'Alice A' } : null
    );
    fetchMock.mockResolvedValue(
      okResponse({
        users: [
          { email: R1, devices: [{ deviceId: 'a1', isOnline: true }], isOnline: true, totalDevices: 1, tenantIds: [TENANT_ID] },
          { email: R2, devices: [], isOnline: false, totalDevices: 0 },
        ],
      })
    );

    const users = await deviceTrackingService.getAllUsersWithDevices([R1, R2], SELF, false, { tenantId: TENANT_ID });

    const call = callEndingWith('/notifications/device-listing');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      tenantId: TENANT_ID,
      recipientEmails: [R1, R2],
      currentUserEmail: SELF,
      includeCurrentUser: false,
    });

    // Reconstructed AuthorizedUser[] shape with profile overlay, order preserved.
    expect(users).toHaveLength(2);
    expect(users[0]).toEqual(
      expect.objectContaining({
        email: R1,
        role: 'admin',
        displayName: 'Alice A',
        isOnline: true,
        totalDevices: 1,
        tenantIds: [TENANT_ID],
      })
    );
    expect(users[0].devices.map((d: any) => d.deviceId)).toEqual(['a1']);
    // R2 has no profile → falls back to 'user' + email-derived display name.
    expect(users[1]).toEqual(
      expect.objectContaining({ email: R2, role: 'user', isOnline: false, totalDevices: 0, tenantIds: [TENANT_ID] })
    );
    expect(typeof users[1].displayName).toBe('string');

    // No cross-user user_devices read anywhere in the listing.
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('getUserDevices(self) is an Owner_Only_Read: it STILL reads via getDocs and never hits the endpoint', async () => {
    runtime.currentUserEmail = SELF;

    const devices = await deviceTrackingService.getUserDevices(SELF, { tenantId: TENANT_ID });

    // Self-read stays a direct client Firestore read.
    expect(mockGetDocs).toHaveBeenCalled();
    // And it never delegates to the server device-listing.
    expect(callEndingWith('/notifications/device-listing')).toBeUndefined();
    expect(Array.isArray(devices)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flag OFF — legacy client reads, endpoints never hit
// ---------------------------------------------------------------------------

describe('Cross_User_Readers — legacy client path (flag OFF)', () => {
  beforeEach(() => {
    process.env[FLAG] = 'false';
  });

  it('getUserDevices(other) reads the recipient devices via getDocs and never calls the device-listing endpoint', async () => {
    const devices = await deviceTrackingService.getUserDevices(OTHER, { tenantId: TENANT_ID });

    expect(mockGetDocs).toHaveBeenCalled();
    expect(callEndingWith('/notifications/device-listing')).toBeUndefined();
    expect(Array.isArray(devices)).toBe(true);
  });

  it('checkUserOnlineStatus(other) reads via getDocs and never calls the online-status endpoint', async () => {
    const online = await deviceTrackingService.checkUserOnlineStatus(OTHER);

    expect(mockGetDocs).toHaveBeenCalled();
    expect(callEndingWith('/notifications/online-status')).toBeUndefined();
    expect(online).toBe(false);
  });

  it('getAllUsersWithDevices(...) reads via getDocs and never calls the device-listing endpoint', async () => {
    // Legacy path scopes emails to tenant membership before reading.
    mockGetActiveMembershipsForTenant.mockResolvedValue([{ email: R1 }]);

    const users = await deviceTrackingService.getAllUsersWithDevices([R1], SELF, false, { tenantId: TENANT_ID });

    expect(mockGetDocs).toHaveBeenCalled();
    expect(callEndingWith('/notifications/device-listing')).toBeUndefined();
    expect(Array.isArray(users)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retirement — getUserPushTokens cross-user token listing is gone
// ---------------------------------------------------------------------------

describe('getUserPushTokens retirement', () => {
  it('no longer exists on the service — another user\'s push tokens can never be listed client-side', () => {
    expect((deviceTrackingService as any).getUserPushTokens).toBeUndefined();
  });
});
