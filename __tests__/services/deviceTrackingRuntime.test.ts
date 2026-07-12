// Feature: device-console-migration, Task 18.2 — Runtime tests for signal/ban enforcement.
//
// The Device Console migration retires the client admin *mutation* UI but keeps
// the on-device Device_Tracking_Runtime (`services/deviceTrackingService.ts`)
// intact. These focused unit tests exercise the three runtime paths the design
// relies on, in isolation, with Firestore + auth/sign-out fully mocked (no real
// network / Firestore):
//
//   Test A (Req 7.2, 18.2): consuming an UNCONSUMED Force_Logout_Signal marks it
//     consumed and drives the runtime to sign the user out.
//   Test B (Req 7.6 sign-out, 18.3): an ACTIVE Device_Ban matching the current
//     device reports banned and drives the user to a signed-out state.
//   Test C (Req 18.4, and the timing side of 7.2/7.6): the heartbeat/poll
//     interval constant that drives both checks is <= 60s.
//
// The runtime methods under test (see services/deviceTrackingService.ts):
//   - `checkLogoutSignal(userEmail, deviceId)`  reads
//     `logout_signals/{email}_{deviceId}`, and when the doc exists with
//     `consumed !== true`, updates it to `{ consumed: true, consumedAt }` and
//     returns true.
//   - `handleForceLogout()` (private) stops the heartbeat, best-effort marks the
//     device offline, clears session, and calls `authService.signOut()`.
//   - `isDeviceBannedForUser(device, userEmail)` queries `device_bans` for an
//     active ban matching the device fingerprint + target user, deactivating any
//     expired ban and otherwise returning the active ban.
//   - `HEARTBEAT_INTERVAL` (30000ms) is the cadence of `startHeartbeat`, whose
//     loop calls `checkLogoutSignal` then (probabilistically) `isDeviceBannedForUser`
//     and, on either positive result, `handleForceLogout` — mirrored here.
//
// NOTE on the "within 5s" ban / "within 10s" logout timing: those are enforced by
// the poll cadence, not by a measurable delay inside a unit test. The cadence is
// asserted structurally in Test C (interval <= 60s); Tests A/B assert the
// enforcement *decision* (signal/ban -> sign out).

// ---------------------------------------------------------------------------
// Module-level mocks — all declared before the service is imported. Jest hoists
// the `jest.mock(...)` calls above the import; the factories reference only
// `mock`-prefixed outer bindings (lazily, at call time) or self-contained values.
// ---------------------------------------------------------------------------

const mockSignOut = jest.fn(async (..._args: any[]) => {});
const mockGetDoc = jest.fn((..._args: any[]): any => undefined);
const mockUpdateDoc = jest.fn(async (..._args: any[]) => {});
const mockGetDocs = jest.fn((..._args: any[]): any => undefined);

// Firestore mock: `doc`/`collection`/`query`/`where` return lightweight ref-like
// descriptors so we can assert on the target; `getDoc`/`updateDoc`/`getDocs` are
// controlled per-test. `Timestamp` is a self-contained class so `instanceof` and
// `Timestamp.fromDate(...)` used by the service resolve consistently.
jest.mock('firebase/firestore', () => {
  class MockTimestamp {
    constructor(public _date: Date) {}
    static fromDate(date: Date) {
      return new MockTimestamp(date);
    }
    toDate() {
      return this._date;
    }
  }
  return {
    __esModule: true,
    doc: (_db: unknown, ...segments: string[]) => ({ __type: 'doc', path: segments.join('/') }),
    collection: (_db: unknown, ...segments: string[]) => ({ __type: 'collection', path: segments.join('/') }),
    query: (...args: unknown[]) => ({ __type: 'query', args }),
    where: (field: string, op: string, value: unknown) => ({ __type: 'where', field, op, value }),
    orderBy: (...args: unknown[]) => ({ __type: 'orderBy', args }),
    limit: (...args: unknown[]) => ({ __type: 'limit', args }),
    getDoc: (...args: any[]) => mockGetDoc(...args),
    updateDoc: (...args: any[]) => mockUpdateDoc(...args),
    getDocs: (...args: any[]) => mockGetDocs(...args),
    setDoc: jest.fn(async () => {}),
    addDoc: jest.fn(async () => ({ id: 'mock-doc' })),
    deleteDoc: jest.fn(async () => {}),
    deleteField: jest.fn(() => '__deleteField__'),
    serverTimestamp: jest.fn(() => '__serverTimestamp__'),
    onSnapshot: jest.fn(() => () => {}),
    Timestamp: MockTimestamp,
  };
});

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
    signOut: (...args: any[]) => mockSignOut(...args),
    getCurrentUser: jest.fn(() => null),
  },
}));

// Non-web platform so `handleForceLogout` takes the mobile branch (logger.debug)
// rather than calling the web-only global `alert`, which does not exist in the
// node test environment.
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

// Remaining module-scope imports of deviceTrackingService — stubbed so importing
// the service does not pull in real native / firebase dependencies.
jest.mock('@/lib/expoProjectId', () => ({ __esModule: true, resolveExpoProjectId: jest.fn(() => 'project-id') }));
jest.mock('@/lib/notificationChannels', () => ({ __esModule: true, resolveNotificationChannelId: jest.fn(() => 'default') }));
jest.mock('@/services/tenantService', () => ({ __esModule: true, tenantService: {} }));
jest.mock('@/services/internalTokenManager', () => ({ __esModule: true, internalTokenManager: { getToken: jest.fn(async () => 'token'), setBaseUrl: jest.fn() } }));
jest.mock('@/services/maintenanceAlert', () => ({ __esModule: true, maybeShowMaintenanceAlertFromRaw: jest.fn() }));
jest.mock('@/services/runtimeEndpoints', () => ({
  __esModule: true,
  runtimeEndpoints: {
    getSnapshot: jest.fn(() => ({})),
    getPreferredBackendBaseUrl: jest.fn(() => undefined),
  },
}));
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
import { deviceTrackingService, UserDevice } from '../../services/deviceTrackingService';

const runtime = deviceTrackingService as any;

const EMAIL = 'operator@example.com';
const DEVICE_ID = 'device-abc-123';

/** Minimal UserDevice with a stored seed hash so `generateDeviceFingerprint`
 *  returns deterministically without touching crypto/device-info fallbacks. */
function makeDevice(overrides: Partial<UserDevice> = {}): UserDevice {
  return {
    deviceId: DEVICE_ID,
    deviceSeedHash: 'seed-hash-xyz',
    deviceType: 'mobile',
    deviceName: 'Test Device',
    platformOS: 'ios',
    platformVersion: '17.0',
    appVersion: '1.0.0',
    lastSeen: new Date(),
    isOnline: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as UserDevice;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Ensure the singleton has no active session so `handleForceLogout` goes
  // straight to sign-out (skipping the best-effort device-status write).
  runtime.currentUserEmail = null;
  runtime.currentDeviceId = null;
  runtime.heartbeatInterval = null;
});

// ---------------------------------------------------------------------------
// Test A — Force_Logout_Signal consumption drives sign-out (Req 7.2, 18.2)
// ---------------------------------------------------------------------------
describe('Device_Tracking_Runtime: force-logout signal enforcement (Req 7.2, 18.2)', () => {
  it('consumes an unconsumed logout signal and signs the user out', async () => {
    // logout_signals/{email}_{deviceId} exists and is not yet consumed.
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ consumed: false, reason: 'admin_force_logout' }),
    });

    // Runtime signal poll (see startHeartbeat loop): checkLogoutSignal -> if true -> handleForceLogout.
    const shouldLogout = await deviceTrackingService.checkLogoutSignal(EMAIL, DEVICE_ID);

    expect(shouldLogout).toBe(true);
    // The signal was consumed (marked so it is not re-triggered on the next poll).
    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    const [signalRef, patch] = mockUpdateDoc.mock.calls[0];
    expect(signalRef).toEqual(expect.objectContaining({ path: `logout_signals/${EMAIL}_${DEVICE_ID}` }));
    expect(patch).toEqual(expect.objectContaining({ consumed: true }));

    // The runtime then drives sign-out.
    if (shouldLogout) {
      await runtime.handleForceLogout();
    }
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('does not sign out when the signal is already consumed', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ consumed: true }),
    });

    const shouldLogout = await deviceTrackingService.checkLogoutSignal(EMAIL, DEVICE_ID);

    expect(shouldLogout).toBe(false);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('does not sign out when no logout signal exists', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false, data: () => ({}) });

    const shouldLogout = await deviceTrackingService.checkLogoutSignal(EMAIL, DEVICE_ID);

    expect(shouldLogout).toBe(false);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test B — Active Device_Ban drives sign-out (Req 7.6, 18.3)
// ---------------------------------------------------------------------------
describe('Device_Tracking_Runtime: device-ban enforcement (Req 7.6, 18.3)', () => {
  it('reports an active ban and signs the user out', async () => {
    const activeBan = {
      banType: 'hard',
      deviceFingerprint: 'seed-hash-xyz',
      targetUserEmail: EMAIL,
      isActive: true,
      reason: 'policy_violation',
      adminEmail: 'admin@example.com',
      // no expiresAt -> permanent, must NOT be treated as expired
    };
    mockGetDocs.mockResolvedValue({
      docs: [{ id: 'ban-1', data: () => activeBan, ref: { __type: 'banRef', id: 'ban-1' } }],
    });

    const ban = await deviceTrackingService.isDeviceBannedForUser(makeDevice(), EMAIL);

    expect(ban).not.toBeNull();
    expect(ban!.isActive).toBe(true);
    expect(ban!.id).toBe('ban-1');

    // Runtime drives sign-out on a positive ban check (see startHeartbeat loop).
    if (ban) {
      await runtime.handleForceLogout();
    }
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('returns null and does not sign out when there is no active ban', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });

    const ban = await deviceTrackingService.isDeviceBannedForUser(makeDevice(), EMAIL);

    expect(ban).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('deactivates an expired ban and does not sign out', async () => {
    const expiredBan = {
      banType: 'hard',
      deviceFingerprint: 'seed-hash-xyz',
      targetUserEmail: EMAIL,
      isActive: true,
      reason: 'temporary',
      expiresAt: new Date(Date.now() - 60_000), // already elapsed
    };
    const banRef = { __type: 'banRef', id: 'ban-expired' };
    mockGetDocs.mockResolvedValue({
      docs: [{ id: 'ban-expired', data: () => expiredBan, ref: banRef }],
    });

    const ban = await deviceTrackingService.isDeviceBannedForUser(makeDevice(), EMAIL);

    expect(ban).toBeNull();
    // The expired ban was deactivated rather than enforced.
    expect(mockUpdateDoc).toHaveBeenCalledWith(banRef, expect.objectContaining({ isActive: false }));
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test C — Poll cadence stays within the required bound (Req 18.4)
// ---------------------------------------------------------------------------
describe('Device_Tracking_Runtime: poll cadence (Req 18.4, 7.6)', () => {
  it('heartbeat interval that drives signal/ban polling is <= 60s', () => {
    const interval = runtime.HEARTBEAT_INTERVAL;
    expect(typeof interval).toBe('number');
    expect(interval).toBeGreaterThan(0);
    // Req 7.6: check for a Force_Logout_Signal at least once every 60 seconds;
    // Req 18.4: preserved on-device poll cadence. 30000ms satisfies both.
    expect(interval).toBeLessThanOrEqual(60_000);
  });
});
