// Feature: device-push-fanout-migration, Property 15: Fan-out is total (never throws)
//
// Property test for `deviceFanoutService.fanout` (design "Error Handling" +
// Property 15). With the Admin SDK / push primitives MOCKED and fault-injected
// across every I/O boundary — device read, Expo batch, web push, per-device
// cleanup write, and the Token_Refresh_Flag write — `fanout` MUST ALWAYS resolve
// to a well-formed ten-field DeviceNotificationFanoutResult and NEVER propagate
// an unhandled error to the caller (Req 6.5). The `fc.assert` runs at least
// NUM_RUNS (100) iterations (Req 11.6) and the predicate asserts its own run
// count so the iteration count is verifiable.
//
// Mocking mirrors `src/__tests__/deviceAdminService.bulkLimit.property.test.ts`:
// `../firebaseAdmin` is auto-mocked (we drive `getFirestore`), `../pushUtils`'
// `sendExpoMessages` / `markPushTokensInvalid` are jest.fn()s, and `../webPush`'s
// `sendWebPushNotification` is a jest.fn() while the REAL `sanitizeWebPushSubscription`
// is kept (via requireActual) so valid web-push targets still resolve.

import * as fc from 'fast-check';

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

const NUM_RUNS = 150;
const TENANT = 't-fanout';
const RECIPIENT = 'recipient@example.com';
const SENDER = 'sender@example.com';
const RESULT_KEYS = [...FANOUT_RESULT_KEYS].sort();

/** Build a fault-injectable in-memory Admin-SDK stand-in for one recipient. */
function buildDb(opts: {
  docs: Array<{ id: string; data: Record<string, unknown> }>;
  readRejects: boolean;
  cleanupWriteRejects: boolean;
}) {
  const devicesCollection = {
    async get() {
      if (opts.readRejects) {
        throw new Error('device_read_failed');
      }
      return {
        docs: opts.docs.map((d) => ({ id: d.id, data: () => d.data })),
      };
    },
    doc(_deviceId: string) {
      return {
        async update(_data: Record<string, unknown>) {
          if (opts.cleanupWriteRejects) {
            throw new Error('cleanup_write_failed');
          }
        },
      };
    },
  };
  return {
    collection(_name: string) {
      return {
        doc(_email: string) {
          return {
            collection(_sub: string) {
              return devicesCollection;
            },
          };
        },
      };
    },
  };
}

/** Turn a generated descriptor into a raw device-doc shape. */
function toDoc(
  desc: { kind: string; isOnline: boolean | undefined; inTenant: boolean },
  index: number
): { id: string; data: Record<string, unknown> } {
  const tenantIds = desc.inTenant ? [TENANT] : ['some-other-tenant'];
  const base: Record<string, unknown> = { tenantIds, isOnline: desc.isOnline };
  switch (desc.kind) {
    case 'mobile':
      return {
        id: `gen-${index}`,
        data: { ...base, deviceType: 'mobile', apnsToken: `apns-${index}` },
      };
    case 'web':
      return {
        id: `gen-${index}`,
        data: {
          ...base,
          deviceType: 'web',
          webPushSubscription: {
            endpoint: `https://push.example/e-${index}`,
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          },
        },
      };
    case 'web-stale':
      return {
        id: `gen-${index}`,
        data: {
          ...base,
          deviceType: 'web',
          webPushSubscription: {
            endpoint: `https://push.example/stale-${index}`,
            expirationTime: 1, // finite, in the distant past => stale (Req 3.1)
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          },
        },
      };
    case 'web-nosub':
    default:
      return {
        id: `gen-${index}`,
        // subscribed but no endpoint => stale (Req 3.2)
        data: { ...base, deviceType: 'web', webPushStatus: 'subscribed' },
      };
  }
}

const scenarioArb = fc.record({
  devices: fc.array(
    fc.record({
      kind: fc.constantFrom('mobile', 'web', 'web-stale', 'web-nosub'),
      isOnline: fc.constantFrom(true, false, undefined),
      inTenant: fc.boolean(),
    }),
    { minLength: 0, maxLength: 6 }
  ),
  onlineOnly: fc.boolean(),
  notificationType: fc.constantFrom('chat_message', 'notice_created', 'daily_quote', undefined),
  withSender: fc.boolean(),
  // Fault-injection knobs across every I/O boundary.
  getFirestoreThrows: fc.boolean(),
  readRejects: fc.boolean(),
  expoRejects: fc.boolean(),
  webRejects: fc.boolean(),
  cleanupWriteRejects: fc.boolean(),
  markInvalidRejects: fc.boolean(),
  webOk: fc.boolean(),
});

function assertValidResult(result: unknown): void {
  expect(result).toBeTruthy();
  expect(typeof result).toBe('object');
  const record = result as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual(RESULT_KEYS);
  for (const key of RESULT_KEYS) {
    const value = record[key];
    expect(typeof value).toBe('number');
    expect(Number.isFinite(value as number)).toBe(true);
  }
}

describe('deviceFanoutService.fanout — Property 15: totality (never throws)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('always resolves to a valid ten-field result under injected read/delivery/write faults', async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        runs += 1;

        const docs = scenario.devices.map((d, i) => toDoc(d, i));

        mockedGetFirestore.mockImplementation(() => {
          if (scenario.getFirestoreThrows) {
            throw new Error('get_firestore_failed');
          }
          return buildDb({
            docs,
            readRejects: scenario.readRejects,
            cleanupWriteRejects: scenario.cleanupWriteRejects,
          }) as unknown as ReturnType<typeof getFirestore>;
        });

        mockedSendExpo.mockImplementation(async (messages: Array<{ to: string }>) => {
          if (scenario.expoRejects) {
            // 'delivery_timeout' is exactly what the shared `withTimeout` throws
            // on a timeout, so this single knob exercises both the reject AND the
            // timeout paths (both funnel through the same batch try/catch).
            throw new Error('delivery_timeout');
          }
          const results = messages.map((message, index) => ({
            to: String(message.to),
            ok: index % 2 === 0,
            error: index % 2 === 0 ? undefined : 'DeviceNotRegistered',
          }));
          const invalidTokens = messages
            .filter((_message, index) => index % 2 !== 0)
            .map((message) => String(message.to));
          return {
            sent: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
            invalidTokens,
            results,
          };
        });

        mockedSendWebPush.mockImplementation(async () => {
          if (scenario.webRejects) {
            throw new Error('web_push_failed');
          }
          return { ok: scenario.webOk } as Awaited<ReturnType<typeof sendWebPushNotification>>;
        });

        mockedMarkInvalid.mockImplementation(async () => {
          if (scenario.markInvalidRejects) {
            throw new Error('mark_invalid_failed');
          }
        });

        const result = await fanout({
          tenantId: TENANT,
          recipientEmail: RECIPIENT,
          notification: {
            title: 'Title',
            body: 'Body',
            data: {
              type: scenario.notificationType,
              senderEmail: scenario.withSender ? SENDER : undefined,
            },
          },
          onlineOnly: scenario.onlineOnly,
          actor: { id: 'actor', email: SENDER },
        });

        assertValidResult(result);
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  }, 60_000);
});
