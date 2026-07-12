// Feature: device-console-migration — client migration of forceLogoutAllUserDevices.
//
// The Device Console migration relocated privileged device writes to the backend
// and Stage 4 locked the `logout_signals` / `user_devices` collections to
// backend-only writes. `deviceTrackingService.forceLogoutAllUserDevices` used to
// write those collections directly from the device; it now delegates to the
// tenant-admin-authorized backend endpoint
// `POST /tenants/{tenantId}/members/force-logout` using the app's per-user
// internal token.
//
// These tests prove the migrated behavior with Firestore, auth, and fetch fully
// mocked (no real network / Firestore), mirroring the mocking style in
// `deviceTrackingRuntime.test.ts`:
//   - it POSTs to `/tenants/{tenantId}/members/force-logout` with a
//     `Authorization: Bearer <token>` header and a `{ email }` body;
//   - it performs NO Firestore write (no setDoc/updateDoc/addDoc/deleteDoc on
//     `logout_signals` / `user_devices`);
//   - when the base URL or token is unavailable it throws a clear error (so the
//     caller's try/catch can log + continue) and still writes nothing.

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the service is imported.
// ---------------------------------------------------------------------------

const mockSetDoc = jest.fn(async (..._args: any[]) => {});
const mockUpdateDoc = jest.fn(async (..._args: any[]) => {});
const mockAddDoc = jest.fn(async (..._args: any[]) => ({ id: 'mock-doc' }));
const mockDeleteDoc = jest.fn(async (..._args: any[]) => {});
const mockGetDoc = jest.fn(async (..._args: any[]): Promise<any> => ({ exists: () => false, data: () => ({}) }));
const mockGetDocs = jest.fn(async (..._args: any[]): Promise<any> => ({ docs: [], empty: true, size: 0 }));

// Firestore is mocked so any accidental write would be observable (and asserted
// against). `doc`/`collection` return ref-like descriptors carrying the path.
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

jest.mock('react-native', () => ({
  __esModule: true,
  Platform: { OS: 'ios' },
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

// The two collaborators exercised by the migrated method.
const mockGetToken = jest.fn(async (..._args: any[]): Promise<string | undefined> => 'internal-token-abc');
const mockForceRefresh = jest.fn(async (..._args: any[]): Promise<string | undefined> => 'internal-token-refreshed');
const mockGetPreferredBackendBaseUrl = jest.fn((): string | undefined => 'https://api.example.com');

jest.mock('@/services/internalTokenManager', () => ({
  __esModule: true,
  internalTokenManager: {
    getToken: (...args: any[]) => mockGetToken(...args),
    forceRefresh: (...args: any[]) => mockForceRefresh(...args),
    setBaseUrl: jest.fn(),
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
import { deviceTrackingService } from '../../services/deviceTrackingService';

const EMAIL = 'removed-user@example.com';
const TENANT_ID = 'tenant-abc-123';
const BASE_URL = 'https://api.example.com';

/** A successful fetch Response stand-in. */
function okResponse(bodyJson: unknown = { ok: true, affected: 2 }) {
  return {
    ok: true,
    status: 200,
    json: jest.fn(async () => bodyJson),
    text: jest.fn(async () => JSON.stringify(bodyJson)),
  } as any;
}

/** Assert that no privileged Firestore write was performed by the method. */
function expectNoDeviceFirestoreWrites() {
  expect(mockSetDoc).not.toHaveBeenCalled();
  expect(mockUpdateDoc).not.toHaveBeenCalled();
  expect(mockAddDoc).not.toHaveBeenCalled();
  expect(mockDeleteDoc).not.toHaveBeenCalled();
}

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPreferredBackendBaseUrl.mockReturnValue(BASE_URL);
  mockGetToken.mockResolvedValue('internal-token-abc');
  mockForceRefresh.mockResolvedValue('internal-token-refreshed');
  fetchMock = jest.fn(async () => okResponse());
  (global as any).fetch = fetchMock;
});

// ---------------------------------------------------------------------------
// Happy path — POSTs to the backend endpoint, writes nothing to Firestore
// ---------------------------------------------------------------------------

describe('deviceTrackingService.forceLogoutAllUserDevices — backend delegation', () => {
  it('POSTs to /tenants/{tenantId}/members/force-logout with bearer token + { email } and no Firestore write', async () => {
    await deviceTrackingService.forceLogoutAllUserDevices(EMAIL, TENANT_ID, 'User removed from authorized list');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/tenants/${TENANT_ID}/members/force-logout`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        Authorization: 'Bearer internal-token-abc',
      })
    );
    expect(JSON.parse(init.body)).toEqual({ email: EMAIL });

    // Crucially: no direct writes to logout_signals / user_devices (or anywhere).
    expectNoDeviceFirestoreWrites();
  });

  it('resolves the token against the resolved backend base URL', async () => {
    await deviceTrackingService.forceLogoutAllUserDevices(EMAIL, TENANT_ID);

    expect(mockGetToken).toHaveBeenCalledWith(BASE_URL);
  });

  it('retries once with a refreshed token on a 401 and still writes nothing', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401, text: jest.fn(async () => 'unauthorized') } as any)
      .mockResolvedValueOnce(okResponse());

    await deviceTrackingService.forceLogoutAllUserDevices(EMAIL, TENANT_ID);

    expect(mockForceRefresh).toHaveBeenCalledWith(BASE_URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry used the refreshed token.
    const [, retryInit] = fetchMock.mock.calls[1];
    expect(retryInit.headers.Authorization).toBe('Bearer internal-token-refreshed');
    expectNoDeviceFirestoreWrites();
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation — clear errors when prerequisites are unavailable
// ---------------------------------------------------------------------------

describe('deviceTrackingService.forceLogoutAllUserDevices — degradation', () => {
  it('throws (and writes nothing / does not fetch) when no tenantId is provided', async () => {
    await expect(
      deviceTrackingService.forceLogoutAllUserDevices(EMAIL, '   ')
    ).rejects.toThrow(/tenantId/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expectNoDeviceFirestoreWrites();
  });

  it('throws (and writes nothing / does not fetch) when the backend base URL is unavailable', async () => {
    mockGetPreferredBackendBaseUrl.mockReturnValue(undefined);

    await expect(
      deviceTrackingService.forceLogoutAllUserDevices(EMAIL, TENANT_ID)
    ).rejects.toThrow(/base URL/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expectNoDeviceFirestoreWrites();
  });

  it('throws (and writes nothing) when no internal token can be minted', async () => {
    mockGetToken.mockResolvedValue(undefined);

    await expect(
      deviceTrackingService.forceLogoutAllUserDevices(EMAIL, TENANT_ID)
    ).rejects.toThrow(/token/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expectNoDeviceFirestoreWrites();
  });

  it('throws on a non-ok backend response and writes nothing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: jest.fn(async () => 'server error') } as any);

    await expect(
      deviceTrackingService.forceLogoutAllUserDevices(EMAIL, TENANT_ID)
    ).rejects.toThrow(/Force logout request failed/i);

    expectNoDeviceFirestoreWrites();
  });
});
