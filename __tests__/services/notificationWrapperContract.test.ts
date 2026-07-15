// Feature: device-push-fanout-migration, Stage 2 (Task 8.1) — the notification
// wrappers in `services/notificationService.ts` (and, by delegation, the
// `hooks/useNotifications.ts` wrappers) must keep surfacing the UNCHANGED
// `DeviceNotificationFanoutResult` — the exact ten numeric fields — and preserve
// their existing wrapper signatures across BOTH flag states (flag ON = Server
// fan-out, flag OFF = Client fan-out) (Req 6.1, 9.5).
//
// The Stage 2 change (task 7.1) already preserved the contract at the source
// (`deviceTrackingService.sendNotificationToUser`), and the flag routing itself
// is proven in `deviceFanoutClientDelegation.test.ts`. This suite is the wrapper
// regression guard: it seams the underlying `sendNotificationToUser` so the REAL
// wrapper code runs, and pins that the wrapper
//   - passes the full ten-field contract straight through (never narrows it at
//     runtime to `{ success, failed }`, drops, or renames a field),
//   - reports the identical field set whether the flag is ON or OFF, and
//   - performs no cross-user `user_devices` read of its own.
// A future change that reshapes a wrapper's result therefore cannot pass silently.

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the service is imported. Everything the
// real `notificationService` pulls in at import time is stubbed so the wrapper
// under test runs in isolation (no native / firebase / network dependencies).
// ---------------------------------------------------------------------------

const FLAG = 'EXPO_PUBLIC_SERVER_FANOUT_ENABLED';

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

/** Build a complete ten-field Fanout_Result (as sendNotificationToUser returns). */
function fullResult(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    success: 0,
    failed: 0,
    deliverableDeviceCount: 0,
    onlineDeliverableCount: 0,
    presenceDeliveredCount: 0,
    pushAcceptedCount: 0,
    mobilePushAcceptedCount: 0,
    webPushAcceptedCount: 0,
    staleWebPushSubscriptionsCleaned: 0,
    deduplicatedWebPushSubscriptionsCleaned: 0,
    ...overrides,
  };
}

// The underlying fan-out. It returns a DISTINCT complete ten-field result per
// flag state — mirroring what the Server_Fanout (flag ON) and the Client_Fanout
// (flag OFF) each produce — so the wrapper can only pass the parity check by
// faithfully surfacing whatever it receives, not by hardcoding fields.
const mockSendNotificationToUser = jest.fn(async (..._args: any[]) => {
  return process.env[FLAG] === 'true'
    ? fullResult({
        success: 2,
        deliverableDeviceCount: 2,
        onlineDeliverableCount: 2,
        pushAcceptedCount: 2,
        mobilePushAcceptedCount: 1,
        webPushAcceptedCount: 1,
      })
    : fullResult({
        success: 3,
        deliverableDeviceCount: 3,
        onlineDeliverableCount: 3,
        presenceDeliveredCount: 1,
        pushAcceptedCount: 2,
        mobilePushAcceptedCount: 2,
      });
});
// A cross-user reader we assert the user-broadcast wrapper never touches.
const mockGetUserDevices = jest.fn(async (..._args: any[]) => [] as any[]);

jest.mock('../../services/deviceTrackingService', () => ({
  __esModule: true,
  deviceTrackingService: {
    sendNotificationToUser: (...args: any[]) => mockSendNotificationToUser(...args),
    getUserDevices: (...args: any[]) => mockGetUserDevices(...args),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), metric: jest.fn() },
}));
jest.mock('@/lib/expoProjectId', () => ({ __esModule: true, resolveExpoProjectId: jest.fn(() => 'project-id') }));
jest.mock('@/lib/notificationChannels', () => ({
  __esModule: true,
  ANDROID_CHANNEL_IDS: {},
  getAndroidChannelDefinition: jest.fn(() => ({})),
  resolveNotificationChannelId: jest.fn(() => 'default'),
}));
jest.mock('react-native', () => ({ __esModule: true, Platform: { OS: 'web' } }));
jest.mock('expo-notifications', () => ({
  __esModule: true,
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  setNotificationCategoryAsync: jest.fn(async () => {}),
  getPresentedNotificationsAsync: jest.fn(async () => []),
  DEFAULT_ACTION_IDENTIFIER: 'default',
}));
jest.mock('expo-device', () => ({ __esModule: true, isDevice: false }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) },
}));
jest.mock('../../services/twilioBackendClient', () => ({ __esModule: true, twilioBackendClient: {} }));
jest.mock('../../services/wabaService', () => ({ __esModule: true, whatsappBusinessService: {} }));
jest.mock('../../services/wabaTemplateConstants', () => ({ __esModule: true, getTemplateLanguage: jest.fn(() => 'en') }));
jest.mock('../../services/chatReceiptSync', () => ({
  __esModule: true,
  confirmInboundChatDeliveryFromNotificationData: jest.fn(async () => {}),
  flushPendingInboundChatDeliveryReceipts: jest.fn(async () => {}),
}));
jest.mock('../../services/whatsappConversationService', () => ({ __esModule: true, whatsappConversationService: {} }));
jest.mock('../../services/emailService', () => ({ __esModule: true, emailService: { initialize: jest.fn(async () => {}) } }));
jest.mock('../../services/quotesService', () => ({ __esModule: true, quotesService: {} }));
jest.mock('../../types', () => ({ __esModule: true }));
jest.mock('../../services/chatService', () => ({ __esModule: true, chatService: {} }));
jest.mock('../../services/adminNotificationHistoryService', () => ({ __esModule: true, adminNotificationHistoryService: {} }));
jest.mock('expo-router', () => ({ __esModule: true, router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock('../../services/tenantService', () => ({
  __esModule: true,
  tenantService: { getCachedSelectedTenant: jest.fn(async () => 'tenant-x') },
}));
jest.mock('../../services/runtimeEndpoints', () => ({ __esModule: true, runtimeEndpoints: {} }));

// ---------------------------------------------------------------------------
// Import the real service singleton AFTER the mocks are registered.
// ---------------------------------------------------------------------------
import { notificationService } from '../../services/notificationService';

const RECIPIENT = 'recipient@example.com';
const TENANT_OPTIONS = { tenantId: 'tenant-x', includeUntagged: false } as any;
const NOTIFICATION = { title: 'Heads up', body: 'A wrapper contract test' };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[FLAG];
});

afterAll(() => {
  delete process.env[FLAG];
});

describe('notificationService.sendAdminNotificationToUser — wrapper contract stability', () => {
  it.each([
    ['ON (Server_Fanout)', 'true'],
    ['OFF (Client_Fanout)', 'false'],
  ])('passes the full ten-field DeviceNotificationFanoutResult through with flag %s', async (_label, flag) => {
    process.env[FLAG] = flag;

    const result = await notificationService.sendAdminNotificationToUser(
      RECIPIENT,
      NOTIFICATION,
      true,
      TENANT_OPTIONS
    );

    // The wrapper delegates to the fan-out entry point exactly once...
    expect(mockSendNotificationToUser).toHaveBeenCalledTimes(1);
    // ...and never performs a cross-user user_devices read of its own.
    expect(mockGetUserDevices).not.toHaveBeenCalled();

    // The returned object is the UNCHANGED ten-field contract — not narrowed at
    // runtime to { success, failed }, and no field dropped or renamed.
    expect(Object.keys(result as any).sort()).toEqual(RESULT_KEYS);
    for (const key of RESULT_KEYS) {
      expect(typeof (result as any)[key]).toBe('number');
      expect(Number.isFinite((result as any)[key])).toBe(true);
    }

    // Every field is surfaced faithfully from the underlying fan-out result.
    const underlying = await mockSendNotificationToUser.mock.results[0].value;
    expect(result).toEqual(underlying);
  });

  it('surfaces the identical contract field set whether the flag is ON or OFF', async () => {
    process.env[FLAG] = 'true';
    const onResult = await notificationService.sendAdminNotificationToUser(RECIPIENT, NOTIFICATION, true, TENANT_OPTIONS);

    jest.clearAllMocks();
    process.env[FLAG] = 'false';
    const offResult = await notificationService.sendAdminNotificationToUser(RECIPIENT, NOTIFICATION, true, TENANT_OPTIONS);

    const onKeys = Object.keys(onResult as any).sort();
    const offKeys = Object.keys(offResult as any).sort();
    expect(onKeys).toEqual(RESULT_KEYS);
    expect(offKeys).toEqual(RESULT_KEYS);
    expect(onKeys).toEqual(offKeys);
  });

  it('still preserves its { success, failed } signature via the error fallback', async () => {
    process.env[FLAG] = 'true';
    mockSendNotificationToUser.mockRejectedValueOnce(new Error('boom'));

    const result = await notificationService.sendAdminNotificationToUser(RECIPIENT, NOTIFICATION, true, TENANT_OPTIONS);

    // On failure the wrapper returns the documented { success, failed } shape
    // (never throws to the caller) — the signature is stable in both states.
    expect(result).toEqual({ success: 0, failed: 1 });
  });
});
