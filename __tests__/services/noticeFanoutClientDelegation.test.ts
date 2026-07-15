// Feature: device-push-fanout-migration, Stage 3 (Task 11.2) — notice fan-out
// migration parity.
//
// Proves that the notice fan-out routes through the backend Fanout_Endpoint,
// with `deviceTrackingService` fully mocked (no real Firestore / network),
// mirroring the style of `deviceFanoutClientDelegation.test.ts`:
//
//   - each recipient's push is delegated to
//     `deviceTrackingService.sendNotificationToUser(email, payload, /*onlineOnly*/ false, opts)`
//     (the shipped `POST /notifications/fanout` bridge). The client performs NO
//     cross-user device read (`getUserDevices`) and never calls the per-device
//     `sendNotificationToDevice` (Req 7.1, 7.3, 7.5);
//   - the payload carries the `notice_created` Notification_Type (with
//     `onlineOnly: false` so BOTH online and offline eligible devices are
//     reached) and NO per-device fields leak in — the server Delivery_Filter
//     reproduces the eligible / deduped / non-current delivered set, proven by
//     the backend fast-check suite
//     (`deviceFanoutService.deliveryFilter.property.test.ts`, Properties 1–7,
//     16, 17 and Property 18 for the hard-ban / logout exclusion the notice
//     fan-out relies on).

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the service is imported.
// ---------------------------------------------------------------------------

// deviceTrackingService surface used by noticeService.
const mockGetCurrentDeviceId = jest.fn<string | null, []>(() => null);
const mockGetUserDevices = jest.fn(async (..._args: any[]): Promise<any[]> => []);
const mockGetAllUsers = jest.fn(async (..._args: any[]): Promise<any[]> => []);
// The per-device delivery primitive the server-fanout path must NEVER use.
const mockSendNotificationToDevice = jest.fn(async (..._args: any[]): Promise<boolean> => true);
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
 * A representative recipient device population. It is wired as the default
 * `getUserDevices` resolution so the tests can assert the client NEVER reads it
 * (resolution happens server-side); only `r1@example.com` has devices.
 */
const R1 = 'r1@example.com';
function representativePopulation(): any[] {
  return [
    { deviceId: 'online-1', deviceType: 'mobile', isOnline: true, expoPushToken: 'tok-1' },
    { deviceId: 'offline-1', deviceType: 'mobile', isOnline: false, expoPushToken: 'tok-2' },
    { deviceId: 'deleted-1', deviceType: 'mobile', isOnline: true, isDeleted: true, expoPushToken: 'tok-3' },
    { deviceId: 'banned-1', deviceType: 'mobile', isOnline: true, isHardBanned: true, expoPushToken: 'tok-4' },
    { deviceId: 'loggedout-1', deviceType: 'mobile', isOnline: false, logoutType: 'forced', expoPushToken: 'tok-5' },
    { deviceId: 'noticeoff-1', deviceType: 'mobile', isOnline: true, noticeNotificationsEnabled: false, expoPushToken: 'tok-6' },
    { deviceId: 'dup-a', deviceType: 'mobile', isOnline: true, expoPushToken: 'tok-shared' },
    { deviceId: 'dup-b', deviceType: 'mobile', isOnline: true, expoPushToken: 'tok-shared' },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  sendNotificationToUserCalls.length = 0;
  mockGetCurrentDeviceId.mockReturnValue(null);
  mockGetCurrentUser.mockReturnValue(null);
  mockGetCachedSelectedTenant.mockResolvedValue(TENANT_ID);
  mockGetActiveMembershipsForTenant.mockResolvedValue([{ email: R1 }]);
  mockGetUserDevices.mockResolvedValue(representativePopulation());
});

// ---------------------------------------------------------------------------
// Server_Fanout — delegates to the Fanout_Endpoint bridge, no cross-user read
// ---------------------------------------------------------------------------

describe('notice fan-out — Server_Fanout', () => {
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
