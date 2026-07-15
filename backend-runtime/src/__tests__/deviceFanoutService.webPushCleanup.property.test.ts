// Feature: device-push-fanout-migration — property suite for the pure Web_Push_Cleanup decision
//
// Co-located property tests for `classifyWebPushCleanup` (design "Data Models →
// Web_Push_Cleanup decision", Properties 8, 9, 10). Each property drives the REAL
// exported decision against generated device sets (no mocks, no I/O) and checks
// it against an INDEPENDENT oracle that re-derives the same client semantics
// (stale-classification, endpoint dedup with freshest-wins/first-seen-on-tie).
// Every `fc.assert` runs at least NUM_RUNS (100) iterations (Req 11.6), and each
// test asserts its predicate executed >= NUM_RUNS times so the run count is
// verifiable.

import * as fc from 'fast-check';

import {
  classifyWebPushCleanup,
  applyDeliveryFilter,
  ACTIVE_CHAT_SUPPRESSION_WINDOW_MS,
  type FanoutDevice,
  type FanoutTimestamp,
  type FilterContext,
  type Notification_Type,
} from '../deviceFanoutService';
import { toEpochMs } from '../lib/deviceLastSeen';

const NUM_RUNS = 100;

const BASE_NOW = 1_700_000_000_000;
const WINDOW = ACTIVE_CHAT_SUPPRESSION_WINDOW_MS; // 120000

// Small endpoint pool so many web devices SHARE an endpoint, which is what makes
// the deduplication path fire.
const ENDPOINTS = ['https://push.example/e1', 'https://push.example/e2'];
const TOKENS = ['tok-A', 'tok-B', 'tok-C'];

const ALL_TYPES: Array<Notification_Type | undefined> = [
  'chat_message',
  'notice_created',
  'team_membership_change',
  'daily_quote',
  undefined,
];

const optionalBool = fc.option(fc.boolean(), { nil: undefined });

// Freshness timestamps spread over a wide window so devices sharing an endpoint
// frequently differ (exercising freshest-wins) and occasionally tie (exercising
// first-seen-on-tie). Expressed as epoch number, ISO string, or undefined — all
// understood by toEpochMs.
const timestampArb = fc.oneof(
  fc.integer({ min: BASE_NOW - 600_000, max: BASE_NOW + 60_000 }),
  fc
    .integer({ min: BASE_NOW - 600_000, max: BASE_NOW + 60_000 })
    .map((n) => new Date(n).toISOString()),
  fc.constant(undefined)
);

// Web-push subscriptions covering: absent; a valid endpoint with an
// expirationTime straddling `now` (expired / future / null / zero); and a
// blank/whitespace endpoint (endpointKey === null).
const webSubArb = fc.oneof(
  fc.constant(undefined),
  fc.record({
    endpoint: fc.constantFrom(...ENDPOINTS),
    expirationTime: fc.oneof(
      fc.integer({ min: BASE_NOW - 600_000, max: BASE_NOW - 1 }), // expired (>0, <= now)
      fc.integer({ min: BASE_NOW + 1, max: BASE_NOW + 600_000 }), // future
      fc.constant<number | null>(null),
      fc.constant<number | null>(0) // 0 is NOT expired (must be > 0)
    ),
    keys: fc.record({ p256dh: fc.constant('p256dh-key'), auth: fc.constant('auth-key') }),
  }),
  fc.record({
    endpoint: fc.constantFrom('', '   '),
    expirationTime: fc.constant<number | null>(null),
    keys: fc.record({ p256dh: fc.constant('p256dh-key'), auth: fc.constant('auth-key') }),
  })
);

// Weight deviceType toward 'web' so shared-endpoint groups actually form.
const deviceTypeArb = fc.constantFrom<FanoutDevice['deviceType']>(
  'web',
  'web',
  'web',
  'mobile',
  'tablet',
  undefined
);

const deviceArb = fc.record({
  deviceType: deviceTypeArb,
  isDeleted: optionalBool,
  isOnline: optionalBool,
  notificationsEnabled: optionalBool,
  chatNotificationsEnabled: optionalBool,
  noticeNotificationsEnabled: optionalBool,
  teamNotificationsEnabled: optionalBool,
  dailyQuotesEnabled: optionalBool,
  apnsToken: fc.option(fc.constantFrom(...TOKENS), { nil: undefined }),
  fcmToken: fc.option(fc.constantFrom(...TOKENS), { nil: undefined }),
  expoPushToken: fc.option(fc.constantFrom(...TOKENS), { nil: undefined }),
  webPushSubscription: webSubArb,
  webPushStatus: fc.constantFrom('subscribed', 'unsubscribed', 'sync_required', undefined),
  updatedAt: timestampArb,
  lastSeen: timestampArb,
  webPushLastSyncedAt: timestampArb,
  webPushSubscribedAt: timestampArb,
  lastTenantPingAt: timestampArb,
});

// Assign unique deviceIds so classification results map back unambiguously.
const devicesArb = fc
  .array(deviceArb, { maxLength: 10 })
  .map((list) =>
    list.map((d, i): FanoutDevice => ({ ...(d as FanoutDevice), deviceId: `gen-${i}` }))
  );

// ---------------------------------------------------------------------------
// Independent oracles (re-derived from the client semantics, not the SUT).
// ---------------------------------------------------------------------------

const endpointKeyOracle = (device: FanoutDevice): string | null => {
  const endpoint =
    typeof device.webPushSubscription?.endpoint === 'string'
      ? device.webPushSubscription.endpoint.trim()
      : '';
  return endpoint || null;
};

const freshnessOracle = (device: FanoutDevice): number => {
  const candidates: Array<FanoutTimestamp | undefined> = [
    device.updatedAt,
    device.lastSeen,
    device.webPushLastSyncedAt,
    device.webPushSubscribedAt,
    device.lastTenantPingAt,
  ];
  let latest = 0;
  for (const value of candidates) {
    const ms = toEpochMs(value);
    if (typeof ms === 'number' && ms > latest) {
      latest = ms;
    }
  }
  return latest;
};

const isStaleOracle = (device: FanoutDevice, now: number): boolean => {
  if (device.deviceType !== 'web' || device.isDeleted === true) {
    return false;
  }
  const endpointKey = endpointKeyOracle(device);
  const rawExpiration = device.webPushSubscription?.expirationTime;
  const expirationTime = typeof rawExpiration === 'number' ? rawExpiration : null;
  const expired =
    typeof expirationTime === 'number' &&
    Number.isFinite(expirationTime) &&
    expirationTime > 0 &&
    expirationTime <= now;
  const subscribedWithoutEndpoint = device.webPushStatus === 'subscribed' && !endpointKey;
  return expired || subscribedWithoutEndpoint;
};

// Group non-stale web devices (in input order) by their trimmed endpoint key.
const endpointGroupsOracle = (
  devices: ReadonlyArray<FanoutDevice>,
  now: number
): Map<string, FanoutDevice[]> => {
  const groups = new Map<string, FanoutDevice[]>();
  for (const device of devices) {
    if (device.deviceType !== 'web' || device.isDeleted === true) {
      continue;
    }
    if (isStaleOracle(device, now)) {
      continue;
    }
    const key = endpointKeyOracle(device);
    if (!key) {
      continue;
    }
    const group = groups.get(key);
    if (group) {
      group.push(device);
    } else {
      groups.set(key, [device]);
    }
  }
  return groups;
};

// The device an endpoint group retains: freshest wins, first-seen breaks ties
// (a running maximum where a strictly fresher candidate displaces the winner).
const groupWinnerOracle = (group: FanoutDevice[]): FanoutDevice => {
  let winner = group[0];
  for (let i = 1; i < group.length; i += 1) {
    if (freshnessOracle(group[i]) > freshnessOracle(winner)) {
      winner = group[i];
    }
  }
  return winner;
};

describe('classifyWebPushCleanup — Web_Push_Cleanup properties', () => {
  it('Property 8: stale web-push subscriptions are classified for cleanup', () => {
    // Feature: device-push-fanout-migration, Property 8: Stale web-push subscriptions are classified for cleanup
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, (devices) => {
        runs += 1;
        const { stale } = classifyWebPushCleanup(devices, BASE_NOW);
        const staleSet = new Set(stale);
        // A device is stale EXACTLY when the oracle says so: expired OR
        // subscribed-without-endpoint, and only for non-deleted web devices.
        for (const device of devices) {
          expect(staleSet.has(device.deviceId)).toBe(isStaleOracle(device, BASE_NOW));
        }
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 9: duplicate web-push endpoints retain only the freshest device', () => {
    // Feature: device-push-fanout-migration, Property 9: Duplicate web-push endpoints retain only the freshest device
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, (devices) => {
        runs += 1;
        const { duplicates, survivors } = classifyWebPushCleanup(devices, BASE_NOW);
        const duplicateSet = new Set(duplicates);
        const survivorIds = new Set(survivors.map((d) => d.deviceId));

        const groups = endpointGroupsOracle(devices, BASE_NOW);
        const expectedDuplicates = new Set<string>();
        for (const group of groups.values()) {
          if (group.length < 2) {
            // A lone device on an endpoint is never a duplicate; it survives.
            expect(survivorIds.has(group[0].deviceId)).toBe(true);
            expect(duplicateSet.has(group[0].deviceId)).toBe(false);
            continue;
          }
          const winner = groupWinnerOracle(group);
          // Exactly the freshest (first-seen on tie) is retained.
          expect(survivorIds.has(winner.deviceId)).toBe(true);
          expect(duplicateSet.has(winner.deviceId)).toBe(false);
          for (const device of group) {
            if (device.deviceId !== winner.deviceId) {
              // Every other sharing device is a removable duplicate.
              expect(duplicateSet.has(device.deviceId)).toBe(true);
              expect(survivorIds.has(device.deviceId)).toBe(false);
              expectedDuplicates.add(device.deviceId);
            }
          }
        }
        // The duplicate set is EXACTLY the non-winners of shared-endpoint groups.
        expect(duplicateSet).toEqual(expectedDuplicates);
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 10: cleaned devices are excluded from the fan-out push targets', () => {
    // Feature: device-push-fanout-migration, Property 10: Cleaned devices are excluded from the fan-out's push targets
    let runs = 0;
    fc.assert(
      fc.property(
        devicesArb,
        fc.constantFrom(...ALL_TYPES),
        fc.boolean(),
        (devices, notificationType, onlineOnly) => {
          runs += 1;
          const { stale, duplicates, survivors } = classifyWebPushCleanup(devices, BASE_NOW);
          const staleSet = new Set(stale);
          const duplicateSet = new Set(duplicates);

          // survivors exclude every stale and every duplicate id ...
          for (const survivor of survivors) {
            expect(staleSet.has(survivor.deviceId)).toBe(false);
            expect(duplicateSet.has(survivor.deviceId)).toBe(false);
          }
          // ... and survivors are exactly input minus stale minus duplicates, in order.
          const expectedSurvivors = devices
            .filter((d) => !staleSet.has(d.deviceId) && !duplicateSet.has(d.deviceId))
            .map((d) => d.deviceId);
          expect(survivors.map((d) => d.deviceId)).toEqual(expectedSurvivors);

          // Composing survivors into the Delivery_Filter yields no push target
          // (web-push or otherwise) whose device was stale/duplicate.
          const ctx: FilterContext = {
            notificationType,
            allowWhenDisabled: true, // bypass toggles so surviving devices can be selected
            onlineOnly,
            senderEmail: null, // avoid chat suppression noise
            nowMs: BASE_NOW,
            activeChatWindowMs: WINDOW,
          };
          const outcome = applyDeliveryFilter(survivors, ctx);
          for (const target of outcome.selected) {
            expect(staleSet.has(target.deviceId)).toBe(false);
            expect(duplicateSet.has(target.deviceId)).toBe(false);
            if (target.channel === 'web_push') {
              // A cleaned-subscription device is never a web-push SelectedTarget.
              expect(staleSet.has(target.deviceId)).toBe(false);
              expect(duplicateSet.has(target.deviceId)).toBe(false);
            }
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });
});
