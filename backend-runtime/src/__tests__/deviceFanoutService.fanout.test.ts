// Feature: device-push-fanout-migration — integration/resilience tests for fanout()
//
// Mock-based unit/integration tests for `deviceFanoutService.fanout` (design
// "Server_Fanout pipeline" + Testing Strategy). With the Admin SDK and push
// primitives mocked, these assert:
//   - recipient devices are read server-side through the Admin SDK (Req 1.1);
//   - delivery flows ONLY through `sendExpoMessages` / `sendWebPushNotification`
//     with no new transport (Req 1.2, 1.5);
//   - a mocked invalid Expo token triggers the Token_Refresh_Flag write with the
//     `markPushTokensInvalid` field shape (Req 3.4);
//   - a forced cleanup write failure isolates to one device and a result is still
//     returned (Req 3.6);
//   - out-of-tenant devices are never candidates (Req 5.2, 5.3);
//   - the active-chat suppression path returns zeros + the cleanup counts (Req 6.4).
//
// Mocking mirrors `deviceAdminService.bulkLimit.property.test.ts`: `../firebaseAdmin`
// is auto-mocked (we drive `getFirestore`), `../pushUtils` exposes jest.fn()s, and
// `../webPush` keeps the REAL `sanitizeWebPushSubscription` (requireActual) while
// `sendWebPushNotification` is a jest.fn().

import { getFirestore } from '../firebaseAdmin';
import { sendExpoMessages, markPushTokensInvalid } from '../pushUtils';
import { sendWebPushNotification } from '../webPush';
import { fanout, FANOUT_RESULT_KEYS } from '../deviceFanoutService';

jest.mock('../firebaseAdmin');
jest.mock('../pushUtils', () => ({
  __esModule: true,
  sendExpoMessages: jest.fn(),
  markPushTokensInvalid: jest.fn(),
}));
jest.mock('../webPush', () => {
  const actual = jest.requireActual('../webPush');
  return {
    __esModule: true,
    ...actual,
    sendWebPushNotification: jest.fn(),
  };
});

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;
const mockedSendExpo = sendExpoMessages as jest.MockedFunction<typeof sendExpoMessages>;
const mockedMarkInvalid = markPushTokensInvalid as jest.MockedFunction<typeof markPushTokensInvalid>;
const mockedSendWebPush = sendWebPushNotification as jest.MockedFunction<
  typeof sendWebPushNotification
>;

const TENANT = 't-fanout';
const RECIPIENT = 'recipient@example.com';
const SENDER = 'sender@example.com';

interface SeedDoc {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Build an in-memory Admin-SDK stand-in for one recipient's devices collection,
 * recording the `get()` and per-device `update()` calls so the tests can assert
 * server-side reads and per-device cleanup-write isolation.
 */
function buildDb(seed: SeedDoc[], failUpdateForDeviceIds: Set<string> = new Set()) {
  const updateCalls: Array<{ deviceId: string; data: Record<string, unknown> }> = [];
  const state = { getCallCount: 0, ownerEmails: [] as string[] };

  const devicesCollection = {
    async get() {
      state.getCallCount += 1;
      return { docs: seed.map((d) => ({ id: d.id, data: () => d.data })) };
    },
    doc(deviceId: string) {
      return {
        async update(data: Record<string, unknown>) {
          updateCalls.push({ deviceId, data });
          if (failUpdateForDeviceIds.has(deviceId)) {
            throw new Error('update_failed');
          }
        },
      };
    },
  };

  const db = {
    collection(name: string) {
      expect(name).toBe('user_devices');
      return {
        doc(email: string) {
          state.ownerEmails.push(email);
          return {
            collection(sub: string) {
              expect(sub).toBe('devices');
              return devicesCollection;
            },
          };
        },
      };
    },
  };

  return { db, updateCalls, state };
}

function useDb(seed: SeedDoc[], failUpdateForDeviceIds?: Set<string>) {
  const built = buildDb(seed, failUpdateForDeviceIds);
  mockedGetFirestore.mockReturnValue(built.db as unknown as ReturnType<typeof getFirestore>);
  return built;
}

/** An index-aligned all-ok Expo batch result for the given messages. */
function allOkExpo(messages: Array<{ to: string }>) {
  const results = messages.map((m) => ({ to: String(m.to), ok: true }));
  return { sent: results.length, failed: 0, invalidTokens: [] as string[], results };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSendExpo.mockImplementation(async (messages: Array<{ to: string }>) => allOkExpo(messages));
  mockedSendWebPush.mockResolvedValue({ ok: true } as Awaited<
    ReturnType<typeof sendWebPushNotification>
  >);
  mockedMarkInvalid.mockResolvedValue(undefined);
});

describe('deviceFanoutService.fanout — resolution, reuse & resilience', () => {
  it('reads recipient devices server-side and delivers only via sendExpoMessages / sendWebPushNotification (Req 1.1, 1.2, 1.5)', async () => {
    const seed: SeedDoc[] = [
      {
        id: 'mobile-1',
        data: {
          deviceType: 'mobile',
          // Production shape that triggered the bug: the device carries BOTH a
          // valid Expo token AND a raw fcm token. Only the ExponentPushToken is
          // deliverable server-side (Expo is the only mobile transport) — the raw
          // fcm token must NEVER be handed to sendExpoMessages.
          expoPushToken: 'ExponentPushToken[mobile-1]',
          fcmToken: 'raw-fcm:APA91bMobile1',
          isOnline: true,
          tenantIds: [TENANT],
        },
      },
      {
        id: 'web-1',
        data: {
          deviceType: 'web',
          isOnline: true,
          tenantIds: [TENANT],
          webPushSubscription: {
            endpoint: 'https://push.example/web-1',
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          },
        },
      },
    ];
    const { state } = useDb(seed);

    const result = await fanout({
      tenantId: TENANT,
      recipientEmail: RECIPIENT,
      notification: { title: 'Hello', body: 'World', data: { type: 'notice_created' } },
      onlineOnly: true,
      actor: { email: SENDER },
    });

    // Devices resolved server-side through the Admin SDK exactly once (Req 1.1).
    expect(state.getCallCount).toBe(1);
    expect(state.ownerEmails).toContain(RECIPIENT);

    // Delivery flows ONLY through the reused primitives (Req 1.2, 1.5).
    expect(mockedSendExpo).toHaveBeenCalledTimes(1);
    const expoMessages = mockedSendExpo.mock.calls[0][0] as Array<{ to: string }>;
    // Regression lock: the ExponentPushToken is delivered, NEVER the raw fcm token
    // (which Expo would reject as "not a valid Expo push token").
    expect(expoMessages.map((m) => m.to)).toEqual(['ExponentPushToken[mobile-1]']);
    expect(expoMessages.map((m) => m.to)).not.toContain('raw-fcm:APA91bMobile1');
    expect(mockedSendExpo.mock.calls[0][1]).toMatchObject({ context: 'device_fanout' });

    expect(mockedSendWebPush).toHaveBeenCalledTimes(1);
    expect(mockedSendWebPush.mock.calls[0][0]).toMatchObject({
      subscription: { endpoint: 'https://push.example/web-1' },
    });

    expect(result.mobilePushAcceptedCount).toBe(1);
    expect(result.webPushAcceptedCount).toBe(1);
    expect(result.pushAcceptedCount).toBe(2);
    expect(result.deliverableDeviceCount).toBe(2);
    expect(result.success).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.presenceDeliveredCount).toBe(0); // presence stays client-side
    expect(Object.keys(result).sort()).toEqual([...FANOUT_RESULT_KEYS].sort());
  });

  it('flags an invalid Expo token for refresh via markPushTokensInvalid with the correct device path (Req 3.4)', async () => {
    const seed: SeedDoc[] = [
      {
        id: 'mobile-bad',
        data: { deviceType: 'mobile', expoPushToken: 'expo-bad', isOnline: true, tenantIds: [TENANT] },
      },
    ];
    useDb(seed);

    mockedSendExpo.mockImplementation(async (messages: Array<{ to: string }>) => ({
      sent: 0,
      failed: messages.length,
      invalidTokens: messages.map((m) => String(m.to)),
      results: messages.map((m) => ({ to: String(m.to), ok: false, error: 'DeviceNotRegistered' })),
    }));

    const result = await fanout({
      tenantId: TENANT,
      recipientEmail: RECIPIENT,
      notification: { title: 'Hello', body: 'World', data: { type: 'notice_created' } },
      onlineOnly: true,
      actor: { email: SENDER },
    });

    expect(mockedMarkInvalid).toHaveBeenCalledTimes(1);
    const [records, options] = mockedMarkInvalid.mock.calls[0];
    expect(options).toMatchObject({ context: 'device_fanout' });
    expect(records).toEqual([
      expect.objectContaining({
        token: 'expo-bad',
        deviceId: 'mobile-bad',
        ownerEmail: RECIPIENT,
        deviceDocPath: `user_devices/${RECIPIENT}/devices/mobile-bad`,
      }),
    ]);

    expect(result.mobilePushAcceptedCount).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('isolates a per-device cleanup write failure and still returns a result (Req 3.6)', async () => {
    const seed: SeedDoc[] = [
      {
        id: 'web-stale-1',
        data: {
          deviceType: 'web',
          tenantIds: [TENANT],
          webPushSubscription: {
            endpoint: 'https://push.example/stale-1',
            expirationTime: 1, // in the past => stale (Req 3.1)
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          },
        },
      },
      {
        id: 'web-stale-2',
        data: {
          deviceType: 'web',
          tenantIds: [TENANT],
          webPushSubscription: {
            endpoint: 'https://push.example/stale-2',
            expirationTime: 1,
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          },
        },
      },
      {
        id: 'mobile-ok',
        data: {
          deviceType: 'mobile',
          expoPushToken: 'ExponentPushToken[mobile-ok]',
          isOnline: true,
          tenantIds: [TENANT],
        },
      },
    ];
    // The cleanup write for the first stale device throws.
    const { updateCalls } = useDb(seed, new Set(['web-stale-1']));

    const result = await fanout({
      tenantId: TENANT,
      recipientEmail: RECIPIENT,
      notification: { title: 'Hello', body: 'World', data: { type: 'notice_created' } },
      onlineOnly: false,
      actor: { email: SENDER },
    });

    // Both stale devices had a cleanup write attempted; the failure did not abort
    // the other write nor the fan-out (Req 3.6).
    const cleaned = updateCalls.map((c) => c.deviceId).sort();
    expect(cleaned).toEqual(['web-stale-1', 'web-stale-2']);

    // Stale cleanup is counted by decided-id set even when one write failed.
    expect(result.staleWebPushSubscriptionsCleaned).toBe(2);
    // The deliverable mobile device was still delivered to.
    expect(result.mobilePushAcceptedCount).toBe(1);
    expect(result.failed).toBe(0);
    // A well-formed result is returned (not the failure result).
    expect(Object.keys(result).sort()).toEqual([...FANOUT_RESULT_KEYS].sort());
  });

  it('excludes out-of-tenant devices from candidacy (Req 5.2, 5.3)', async () => {
    const seed: SeedDoc[] = [
      {
        id: 'mobile-in',
        data: {
          deviceType: 'mobile',
          expoPushToken: 'ExponentPushToken[in]',
          isOnline: true,
          tenantIds: [TENANT],
        },
      },
      {
        id: 'mobile-out',
        data: {
          deviceType: 'mobile',
          expoPushToken: 'ExponentPushToken[out]',
          isOnline: true,
          tenantIds: ['other-tenant'],
        },
      },
    ];
    useDb(seed);

    const result = await fanout({
      tenantId: TENANT,
      recipientEmail: RECIPIENT,
      notification: { title: 'Hello', body: 'World', data: { type: 'notice_created' } },
      onlineOnly: true,
      actor: { email: SENDER },
    });

    expect(mockedSendExpo).toHaveBeenCalledTimes(1);
    const expoTokens = (mockedSendExpo.mock.calls[0][0] as Array<{ to: string }>).map((m) => m.to);
    expect(expoTokens).toEqual(['ExponentPushToken[in]']); // the out-of-tenant token is never a target
    expect(result.deliverableDeviceCount).toBe(1);
    expect(result.mobilePushAcceptedCount).toBe(1);
  });

  it('suppresses the whole chat fan-out (zeros) while still reporting cleanup counts (Req 6.4)', async () => {
    const now = Date.now();
    const seed: SeedDoc[] = [
      {
        id: 'viewer',
        data: {
          deviceType: 'mobile',
          apnsToken: 'apns-viewer',
          isOnline: true,
          tenantIds: [TENANT],
          activeChatIsFocused: true,
          activeChatPartner: SENDER,
          activeChatLastSeenAt: now,
        },
      },
      {
        id: 'web-stale',
        data: {
          deviceType: 'web',
          tenantIds: [TENANT],
          webPushSubscription: {
            endpoint: 'https://push.example/stale',
            expirationTime: 1, // stale => cleaned before suppression is decided
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          },
        },
      },
    ];
    const { updateCalls } = useDb(seed);

    const result = await fanout({
      tenantId: TENANT,
      recipientEmail: RECIPIENT,
      notification: {
        title: 'Chat',
        body: 'msg',
        data: { type: 'chat_message', senderEmail: SENDER },
      },
      onlineOnly: true,
      actor: { email: SENDER },
    });

    // No delivery happened under suppression.
    expect(mockedSendExpo).not.toHaveBeenCalled();
    expect(mockedSendWebPush).not.toHaveBeenCalled();

    // Every count is zero EXCEPT the cleanup counts (Req 6.4).
    expect(result.success).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.deliverableDeviceCount).toBe(0);
    expect(result.onlineDeliverableCount).toBe(0);
    expect(result.presenceDeliveredCount).toBe(0);
    expect(result.pushAcceptedCount).toBe(0);
    expect(result.mobilePushAcceptedCount).toBe(0);
    expect(result.webPushAcceptedCount).toBe(0);

    // The stale web-push cleanup still ran and is reported.
    expect(updateCalls.map((c) => c.deviceId)).toContain('web-stale');
    expect(result.staleWebPushSubscriptionsCleaned).toBe(1);
  });
});

describe('deviceFanoutService.fanout — single-device targeting (Part B, targetDeviceId)', () => {
  // Two deliverable devices; targeting one must deliver ONLY to that device.
  const twoDeviceSeed: SeedDoc[] = [
    {
      id: 'mobile-target',
      data: {
        deviceType: 'mobile',
        expoPushToken: 'ExponentPushToken[target]',
        isOnline: true,
        tenantIds: [TENANT],
      },
    },
    {
      id: 'mobile-other',
      data: {
        deviceType: 'mobile',
        expoPushToken: 'ExponentPushToken[other]',
        isOnline: true,
        tenantIds: [TENANT],
      },
    },
  ];

  it('restricts delivery to the single target device when targetDeviceId matches', async () => {
    useDb(twoDeviceSeed);

    const result = await fanout({
      tenantId: TENANT,
      recipientEmail: RECIPIENT,
      notification: { title: 'Hi', body: 'there', data: { type: 'chat_message', senderEmail: SENDER } },
      onlineOnly: false,
      targetDeviceId: 'mobile-target',
      actor: { email: SENDER },
    });

    // Exactly one Expo message, to the target device's token only.
    expect(mockedSendExpo).toHaveBeenCalledTimes(1);
    const expoTokens = (mockedSendExpo.mock.calls[0][0] as Array<{ to: string }>).map((m) => m.to);
    expect(expoTokens).toEqual(['ExponentPushToken[target]']); // the OTHER device is never targeted

    expect(result.deliverableDeviceCount).toBe(1);
    expect(result.mobilePushAcceptedCount).toBe(1);
    expect(result.pushAcceptedCount).toBe(1);
    expect(result.success).toBe(1);
  });

  it('delivers nothing (all-zero result) when targetDeviceId matches no device', async () => {
    useDb(twoDeviceSeed);

    const result = await fanout({
      tenantId: TENANT,
      recipientEmail: RECIPIENT,
      notification: { title: 'Hi', body: 'there', data: { type: 'chat_message', senderEmail: SENDER } },
      onlineOnly: false,
      targetDeviceId: 'does-not-exist',
      actor: { email: SENDER },
    });

    // No candidate → no delivery on any channel.
    expect(mockedSendExpo).not.toHaveBeenCalled();
    expect(mockedSendWebPush).not.toHaveBeenCalled();

    expect(result.deliverableDeviceCount).toBe(0);
    expect(result.pushAcceptedCount).toBe(0);
    expect(result.success).toBe(0);
    expect(result.failed).toBe(0);
    // A well-formed result is still returned.
    expect(Object.keys(result).sort()).toEqual([...FANOUT_RESULT_KEYS].sort());
  });

  it('applies the Delivery_Filter to the single target (per-type toggle still excludes it)', async () => {
    // The target device has chat notifications disabled; a non-allowWhenDisabled
    // chat push must exclude it, yielding no delivery even though it is targeted.
    useDb([
      {
        id: 'mobile-target',
        data: {
          deviceType: 'mobile',
          expoPushToken: 'ExponentPushToken[target]',
          isOnline: true,
          tenantIds: [TENANT],
          chatNotificationsEnabled: false,
        },
      },
    ]);

    const result = await fanout({
      tenantId: TENANT,
      recipientEmail: RECIPIENT,
      notification: { title: 'Hi', body: 'there', data: { type: 'chat_message', senderEmail: SENDER } },
      onlineOnly: false,
      targetDeviceId: 'mobile-target',
      actor: { email: SENDER },
    });

    expect(mockedSendExpo).not.toHaveBeenCalled();
    expect(result.deliverableDeviceCount).toBe(0);
    expect(result.pushAcceptedCount).toBe(0);
  });
});
