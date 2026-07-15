// Feature: device-push-fanout-migration, Stage 3 (Task 11.2) — notice fan-out
// migration parity.
//
// Proves that routing the notice fan-out through the backend Fanout_Endpoint
// (under the Fanout_Feature_Flag) produces the SAME observable delivery outcome
// as the retired client reader, with `deviceTrackingService` fully mocked (no
// real Firestore / network), mirroring the style of
// `deviceFanoutClientDelegation.test.ts`:
//
//   - flag ON  → each recipient's push is delegated to
//     `deviceTrackingService.sendNotificationToUser(email, payload, /*onlineOnly*/ false, opts)`
//     (the shipped `POST /notifications/fanout` bridge). The client performs NO
//     cross-user device read (`getUserDevices`) and never calls the per-device
//     `sendNotificationToDevice` (Req 7.1, 7.3, 7.5);
//   - flag OFF → the legacy client path runs UNCHANGED: it reads the recipient's
//     devices and delivers to the eligible / deduped / non-current devices (Req 9.2);
//   - for a representative device population the legacy path's observable delivered
//     set (online + offline eligible, minus deleted / hard-banned / logged-out /
//     `noticeNotificationsEnabled === false`, mobile-token deduped, sender's
//     current device suppressed) is exactly the GOLDEN set the server
//     Delivery_Filter reproduces — the server side of that parity is proven by the
//     backend fast-check suite (`deviceFanoutService.deliveryFilter.property.test.ts`,
//     Properties 1–7, 16, 17 and the new Property 18 for the hard-ban / logout
//     exclusion the notice fan-out relies on).

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the service is imported.
// ---------------------------------------------------------------------------

const FLAG = 'EXPO_PUBLIC_SERVER_FANOUT_ENABLED';

// Controls the flag the way the real `isServerFanoutEnabled` does (env-driven).
const mockIsServerFanoutEnabled = jest.fn(() => process.env[FLAG] === 'true');

// deviceTrackingService surface used by noticeService.
const mockGetCurrentDeviceId = jest.fn<string | null, []>(() => null);
const mockGetUserDevices = jest.fn(async (..._args: any[]): Promise<any[]> => []);
const mockGetAllUsers = jest.fn(async (..._args: any[]): Promise<any[]> => []);
// Records the deviceIds the LEGACY path attempts delivery to (the observable set).
const deliveredDeviceIds: string[] = [];
const mockSendNotificationToDevice = jest.fn(
  async (deviceId: string, ..._rest: any[]): Promise<boolean> => {
    deliveredDeviceIds.push(deviceId);
    return true;
  }
);
// Records the per-recipient server-fanout delegations.
const sendNotificationToUserCalls: Array<{ email: string; notification: any; onlineOnly: boolean; options: any }> = [];
const mockSendNotificationToUser = jest.fn(
  async (email: string, notification: any, onlineOnly: boolean, options: any) => {
    sendNotificationToUserCalls.push({ email, notification, onlineOnly, options });
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
    };
  }
);

jest.mock('@/services/deviceTrackingService', () => ({
  __esModule: true,
  isServerFanoutEnabled: () => mockIsServerFanoutEnabled(),
  deviceTrackingService: {
    getCurrentDeviceId: () => mockGetCurrentDeviceId(),
    getUserDevices: (...args: any[]) => mockGetUserDevices(...args),
    getAllUsers: (...args: any[]) => mockGetAllUsers(...args),
    sendNotificationToDevice: (...args: any[]) => mockSendNotificationToDevice(args[0], ...args.slice(1)),
    sendNotificationToUser: (...args: any[]) =>
      mockSendNotificationToUser(args[0], args[1], args[2], args[3]),
  },
}));

const mockGetCurrentUser = jest.fn<{ email: string } | null, []>(() => null);
jest.mock('@/hooks/useAuthUnified', () => ({
  __esModule: true,
  authService: {
    getCurrentUser: () => mockGetCurrentUser(),
  },
}));

const mockGetCachedSelectedTenant = jest.fn(async () => 'tenant-1');
const mockGetActiveMembershipsForTenant = jest.fn(async (..._args: any[]): Promise<any[]> => []);
jest.mock('@/services/tenantService', () => ({
  __esModule: true,
  tenantService: {
    getCachedSelectedTenant: () => mockGetCachedSelectedTenant(),
    getActiveMembershipsForTenant: (...args: any[]) => mockGetActiveMembershipsForTenant(...args),
  },
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

// ---------------------------------------------------------------------------
// Import the service singleton after all mocks are registered.
// ---------------------------------------------------------------------------
import { noticeService } from '../../services/noticeService';

const TENANT_ID = 'tenant-1';

/** A minimal Notice (only the fields noticeService reads). */
function makeNotice(overrides: Record<string, any> = {}): any {
  return {
    id: 'notice-1',
    title: 'Server maintenance',
    content: 'The system will be briefly unavailable tonight.',
    priority: 'high',
    tenantId: TENANT_ID,
    createdByName: 'Ada Admin',
    createdByEmail: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    targetAudience: ['all'],
    ...overrides,
  };
}

/**
 * The representative recipient device population. Only `r1@example.com` has
 * devices; the population exercises every eligibility axis + mobile-token dedup.
 */
const R1 = 'r1@example.com';
function representativePopulation(): any[] {
  return [
    // Online eligible mobile → DELIVERED
    { deviceId: 'online-1', deviceType: 'mobile', isOnline: true, expoPushToken: 'tok-1' },
    // Offline eligible mobile (no logout flags) → DELIVERED (notices reach offline too)
    { deviceId: 'offline-1', deviceType: 'mobile', isOnline: false, expoPushToken: 'tok-2' },
    // Deleted → EXCLUDED
    { deviceId: 'deleted-1', deviceType: 'mobile', isOnline: true, isDeleted: true, expoPushToken: 'tok-3' },
    // Hard-banned → EXCLUDED
    { deviceId: 'banned-1', deviceType: 'mobile', isOnline: true, isHardBanned: true, expoPushToken: 'tok-4' },
    // Offline + forced logout → EXCLUDED
    { deviceId: 'loggedout-1', deviceType: 'mobile', isOnline: false, logoutType: 'forced', expoPushToken: 'tok-5' },
    // noticeNotificationsEnabled === false → EXCLUDED
    { deviceId: 'noticeoff-1', deviceType: 'mobile', isOnline: true, noticeNotificationsEnabled: false, expoPushToken: 'tok-6' },
    // Shares a mobile token with dup-b → dup-a DELIVERED, dup-b DEDUPED away
    { deviceId: 'dup-a', deviceType: 'mobile', isOnline: true, expoPushToken: 'tok-shared' },
    { deviceId: 'dup-b', deviceType: 'mobile', isOnline: true, expoPushToken: 'tok-shared' },
  ];
}

/** The GOLDEN observable delivered set for {@link representativePopulation}. */
const GOLDEN_DELIVERED = ['online-1', 'offline-1', 'dup-a'].sort();

beforeEach(() => {
  jest.clearAllMocks();
  deliveredDeviceIds.length = 0;
  sendNotificationToUserCalls.length = 0;
  mockGetCurrentDeviceId.mockReturnValue(null);
  mockGetCurrentUser.mockReturnValue(null);
  mockGetCachedSelectedTenant.mockResolvedValue(TENANT_ID);
  mockGetActiveMembershipsForTenant.mockResolvedValue([{ email: R1 }]);
  mockGetUserDevices.mockResolvedValue(representativePopulation());
  delete process.env[FLAG];
});

afterAll(() => {
  delete process.env[FLAG];
});

// ---------------------------------------------------------------------------
// Flag ON — delegates to the Fanout_Endpoint bridge, no cross-user device read
// ---------------------------------------------------------------------------

describe('notice fan-out — Server_Fanout (flag ON)', () => {
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });

  it('delegates each recipient to sendNotificationToUser with onlineOnly=false and the notice_created payload, and performs NO cross-user device read', async () => {
    mockGetActiveMembershipsForTenant.mockResolvedValue([{ email: R1 }, { email: 'r2@example.com' }]);

    await noticeService.notifyNewNotice(makeNotice());

    // One server-fanout delegation per recipient.
    const emails = sendNotificationToUserCalls.map((c) => c.email).sort();
    expect(emails).toEqual(['r1@example.com', 'r2@example.com']);

    for (const call of sendNotificationToUserCalls) {
      // onlineOnly === false so BOTH online and offline eligible devices are reached.
      expect(call.onlineOnly).toBe(false);
      // notice_created drives the server's Per_Type_Toggle + ban/logout exclusion.
      expect(call.notification.data.type).toBe('notice_created');
      // Recipient-level payload: NO per-device fields leak in.
      expect(call.notification.data.deviceId).toBeUndefined();
      expect(call.notification.data.deliveryScope).toBeUndefined();
      // Notice-identifying fields preserved.
      expect(call.notification.data.noticeId).toBe('notice-1');
      expect(typeof call.notification.title).toBe('string');
      expect(typeof call.notification.body).toBe('string');
      // Tenant scope propagated.
      expect(call.options?.tenantId).toBe(TENANT_ID);
    }

    // CRITICAL: no client path reads another user's user_devices tree, and the
    // legacy per-device delivery primitive is never used.
    expect(mockGetUserDevices).not.toHaveBeenCalled();
    expect(mockSendNotificationToDevice).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Flag OFF — legacy path: reads devices, delivers to the GOLDEN set
// ---------------------------------------------------------------------------

describe('notice fan-out — Client_Fanout (flag OFF)', () => {
  beforeEach(() => {
    process.env[FLAG] = 'false';
  });

  it('runs the legacy path and delivers to exactly the eligible / deduped devices, excluding deleted / hard-banned / logged-out / notice-disabled', async () => {
    await noticeService.notifyNewNotice(makeNotice());

    // Legacy path reads the recipient's devices and never delegates to the endpoint.
    expect(mockGetUserDevices).toHaveBeenCalled();
    expect(mockSendNotificationToUser).not.toHaveBeenCalled();

    // Observable delivered set equals the golden set.
    expect([...deliveredDeviceIds].sort()).toEqual(GOLDEN_DELIVERED);

    // Explicitly assert the excluded devices were NEVER delivered to.
    for (const excluded of ['deleted-1', 'banned-1', 'loggedout-1', 'noticeoff-1', 'dup-b']) {
      expect(deliveredDeviceIds).not.toContain(excluded);
    }
  });

  it("preserves the sender's own current-device suppression when the author is a recipient", async () => {
    // The author is the recipient and is signed in on `online-1`.
    mockGetCurrentUser.mockReturnValue({ email: R1 });
    mockGetCurrentDeviceId.mockReturnValue('online-1');

    await noticeService.notifyNewNotice(makeNotice());

    // `online-1` (the author's current device) is suppressed; the rest of the
    // golden set still receives the notice.
    expect(deliveredDeviceIds).not.toContain('online-1');
    expect([...deliveredDeviceIds].sort()).toEqual(['dup-a', 'offline-1'].sort());
  });
});
