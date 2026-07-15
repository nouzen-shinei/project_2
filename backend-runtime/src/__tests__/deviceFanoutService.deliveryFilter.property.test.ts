// Feature: device-push-fanout-migration — property suite for the pure Delivery_Filter
//
// Co-located property tests for `applyDeliveryFilter` (design §4, Properties
// 1–7, 16, 17). Each property below drives the REAL exported filter against
// generated device sets + contexts (no mocks, no I/O). Every `fc.assert` runs at
// least NUM_RUNS (100) iterations (Req 11.6), and each test additionally asserts
// its predicate executed >= NUM_RUNS times so the run count is verifiable.

import * as fc from 'fast-check';

import {
  applyDeliveryFilter,
  resolvePreferredMobileToken,
  ACTIVE_CHAT_SUPPRESSION_WINDOW_MS,
  type FanoutDevice,
  type FilterContext,
  type FilterOutcome,
  type Notification_Type,
} from '../deviceFanoutService';
import { sanitizeWebPushSubscription } from '../webPush';

const NUM_RUNS = 100;

const SENDER = 'sender@example.com';
const BASE_NOW = 1_700_000_000_000;
const WINDOW = ACTIVE_CHAT_SUPPRESSION_WINDOW_MS; // 120000

// Small pools so devices frequently SHARE tokens/endpoints/partners, which
// exercises deduplication, active-chat matching, and cleanup-adjacent paths.
const TOKENS = ['tok-A', 'tok-B', 'tok-C'];
const ENDPOINTS = ['https://push.example/e1', 'https://push.example/e2'];
const PARTNERS = [SENDER, 'SENDER@EXAMPLE.COM', '  sender@example.com  ', 'other-user@example.com'];

const ALL_TYPES: Array<Notification_Type | undefined> = [
  'chat_message',
  'notice_created',
  'team_membership_change',
  'daily_quote',
  undefined,
];

const optionalBool = fc.option(fc.boolean(), { nil: undefined });

// A timestamp arbitrary spanning in-window and out-of-window values, expressed
// as an epoch number, an ISO string, or undefined — all understood by toEpochMs.
const timestampArb = fc.oneof(
  fc.integer({ min: BASE_NOW - 600_000, max: BASE_NOW + 60_000 }),
  fc
    .integer({ min: BASE_NOW - 600_000, max: BASE_NOW + 60_000 })
    .map((n) => new Date(n).toISOString()),
  fc.constant(undefined)
);

// Web-push subscriptions: valid (endpoint + both keys) and invalid (empty keys,
// which `sanitizeWebPushSubscription` rejects), plus absent.
const webSubArb = fc.oneof(
  fc.constant(undefined),
  fc.record({
    endpoint: fc.constantFrom(...ENDPOINTS),
    expirationTime: fc.option(
      fc.integer({ min: BASE_NOW - 600_000, max: BASE_NOW + 600_000 }),
      { nil: null }
    ),
    keys: fc.record({ p256dh: fc.constant('p256dh-key'), auth: fc.constant('auth-key') }),
  }),
  fc.record({
    endpoint: fc.constantFrom(...ENDPOINTS),
    keys: fc.record({ p256dh: fc.constant(''), auth: fc.constant('') }),
  })
);

const deviceArb = fc.record({
  deviceType: fc.constantFrom('mobile', 'web', 'tablet', undefined),
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
  activeChatIsFocused: optionalBool,
  activeChatPartner: fc.option(fc.constantFrom(...PARTNERS), { nil: undefined }),
  activeChatPartnerId: fc.option(fc.constantFrom(...PARTNERS), { nil: undefined }),
  activeChatLastSeenAt: timestampArb,
  lastSeen: timestampArb,
  updatedAt: timestampArb,
  lastTenantPingAt: timestampArb,
});

// Assign unique deviceIds so selected targets map back unambiguously.
const devicesArb = fc
  .array(deviceArb, { maxLength: 8 })
  .map((list) => list.map((d, i): FanoutDevice => ({ ...(d as FanoutDevice), deviceId: `gen-${i}` })));

const ctxArb = fc.record({
  notificationType: fc.constantFrom(...ALL_TYPES),
  allowWhenDisabled: fc.boolean(),
  onlineOnly: fc.boolean(),
  senderEmail: fc.constantFrom(SENDER, 'other@example.com', null),
  nowMs: fc.constant(BASE_NOW),
  activeChatWindowMs: fc.constant(WINDOW),
}) as fc.Arbitrary<FilterContext>;

// Normalize a FilterOutcome's selection to a comparable, order-preserving shape.
const normSelected = (o: FilterOutcome) =>
  o.selected.map((t) => ({
    id: t.deviceId,
    ch: t.channel,
    tok: t.mobileToken?.token ?? null,
    ep: t.webPushSubscription?.endpoint ?? null,
  }));

const byId = (devices: ReadonlyArray<FanoutDevice>) =>
  new Map(devices.map((d) => [d.deviceId, d]));

describe('applyDeliveryFilter — Delivery_Filter properties', () => {
  it('Property 16: selected devices never exceed candidate devices', () => {
    // Feature: device-push-fanout-migration, Property 16: Selected devices never exceed candidate devices
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, ctxArb, (devices, ctx) => {
        runs += 1;
        const out = applyDeliveryFilter(devices, ctx);
        expect(out.selected.length).toBeLessThanOrEqual(devices.length);
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 17: the Delivery_Filter is idempotent (a fixpoint)', () => {
    // Feature: device-push-fanout-migration, Property 17: The Delivery_Filter is idempotent (a fixpoint)
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, ctxArb, (devices, ctx) => {
        runs += 1;
        const first = applyDeliveryFilter(devices, ctx);
        const selectedIds = new Set(first.selected.map((t) => t.deviceId));
        const selectedDevices = devices.filter((d) => selectedIds.has(d.deviceId));
        const second = applyDeliveryFilter(selectedDevices, ctx);
        // Re-feeding the selected devices selects exactly the same set/order.
        expect(normSelected(second)).toEqual(normSelected(first));
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 5: deleted devices are never selected', () => {
    // Feature: device-push-fanout-migration, Property 5: Deleted devices are never selected
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, ctxArb, (devices, ctx) => {
        runs += 1;
        const out = applyDeliveryFilter(devices, ctx);
        const index = byId(devices);
        for (const target of out.selected) {
          expect(index.get(target.deviceId)?.isDeleted).not.toBe(true);
        }
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 4: onlineOnly excludes offline devices', () => {
    // Feature: device-push-fanout-migration, Property 4: onlineOnly excludes offline devices
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, ctxArb, (devices, ctxPartial) => {
        runs += 1;
        const ctx: FilterContext = { ...ctxPartial, onlineOnly: true };
        const out = applyDeliveryFilter(devices, ctx);
        const index = byId(devices);
        for (const target of out.selected) {
          expect(index.get(target.deviceId)?.isOnline).not.toBe(false);
        }
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 2: a disabled Per_Type_Toggle excludes a device (every Notification_Type)', () => {
    // Feature: device-push-fanout-migration, Property 2: Disabled Per_Type_Toggle excludes a device
    // Each case is a (Notification_Type, applicable-toggle-key) pair. The global
    // `notificationsEnabled` toggle applies to every type; the type-specific
    // toggle applies to its matching type.
    const cases: Array<{ type: Notification_Type | undefined; key: keyof FanoutDevice }> = [
      { type: undefined, key: 'notificationsEnabled' },
      { type: 'chat_message', key: 'notificationsEnabled' },
      { type: 'chat_message', key: 'chatNotificationsEnabled' },
      { type: 'notice_created', key: 'noticeNotificationsEnabled' },
      { type: 'team_membership_change', key: 'teamNotificationsEnabled' },
      { type: 'daily_quote', key: 'dailyQuotesEnabled' },
    ];

    for (const { type, key } of cases) {
      let runs = 0;
      fc.assert(
        fc.property(devicesArb, fc.boolean(), (devices, onlineOnly) => {
          runs += 1;
          // A device deliverable in every respect EXCEPT the applicable toggle,
          // with a unique token so it is never removed by dedup.
          const injected: FanoutDevice = {
            deviceId: 'INJECTED-TOGGLE',
            deviceType: 'mobile',
            isDeleted: false,
            isOnline: true,
            notificationsEnabled: true,
            chatNotificationsEnabled: true,
            noticeNotificationsEnabled: true,
            teamNotificationsEnabled: true,
            dailyQuotesEnabled: true,
            // Deliverable via the backend's only mobile transport (Expo); a
            // unique token so it is never removed by dedup.
            expoPushToken: 'ExponentPushToken[unique-injected-toggle]',
            [key]: false,
          };
          const ctx: FilterContext = {
            notificationType: type,
            allowWhenDisabled: false,
            onlineOnly,
            senderEmail: null, // avoid any chat suppression / per-device chat exclusion
            nowMs: BASE_NOW,
            activeChatWindowMs: WINDOW,
          };
          const out = applyDeliveryFilter([...devices, injected], ctx);
          expect(out.suppressed).toBe(false);
          // The only reason the injected device could be dropped is the toggle,
          // so its absence proves the disabled toggle excluded it.
          expect(out.selected.some((t) => t.deviceId === 'INJECTED-TOGGLE')).toBe(false);
        }),
        { numRuns: NUM_RUNS }
      );
      expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
    }
  });

  it('Property 3: allowWhenDisabled overrides all Per_Type_Toggles', () => {
    // Feature: device-push-fanout-migration, Property 3: allowWhenDisabled overrides all Per_Type_Toggles
    // With allowWhenDisabled=true, the selection is invariant to every toggle
    // value: forcing all toggles true yields the identical selected set, so no
    // toggle value can cause an exclusion (only isDeleted/onlineOnly/active-chat may).
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, ctxArb, (devices, ctxPartial) => {
        runs += 1;
        const ctx: FilterContext = { ...ctxPartial, allowWhenDisabled: true };
        const withActualToggles = applyDeliveryFilter(devices, ctx);
        const togglesForcedTrue = devices.map(
          (d): FanoutDevice => ({
            ...d,
            notificationsEnabled: true,
            chatNotificationsEnabled: true,
            noticeNotificationsEnabled: true,
            teamNotificationsEnabled: true,
            dailyQuotesEnabled: true,
          })
        );
        const withForcedToggles = applyDeliveryFilter(togglesForcedTrue, ctx);
        expect(normSelected(withActualToggles)).toEqual(normSelected(withForcedToggles));
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 6: active-chat viewing suppresses the whole chat fan-out', () => {
    // Feature: device-push-fanout-migration, Property 6: Active-chat viewing suppresses the whole chat fan-out
    let runs = 0;
    fc.assert(
      fc.property(
        devicesArb,
        fc.record({ allowWhenDisabled: fc.boolean(), onlineOnly: fc.boolean() }),
        (devices, opts) => {
          runs += 1;
          // A non-deleted device viewing the sender's conversation right now.
          const viewer: FanoutDevice = {
            deviceId: 'INJECTED-VIEWER',
            deviceType: 'mobile',
            isDeleted: false,
            activeChatIsFocused: true,
            activeChatPartner: SENDER,
            activeChatLastSeenAt: BASE_NOW,
            apnsToken: 'viewer-token',
          };
          const ctx: FilterContext = {
            notificationType: 'chat_message',
            allowWhenDisabled: opts.allowWhenDisabled,
            onlineOnly: opts.onlineOnly,
            senderEmail: SENDER,
            nowMs: BASE_NOW,
            activeChatWindowMs: WINDOW,
          };
          const out = applyDeliveryFilter([...devices, viewer], ctx);
          expect(out.suppressed).toBe(true);
          expect(out.selected).toHaveLength(0);
        }
      ),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 1: mobile token preferred over web-push', () => {
    // Feature: device-push-fanout-migration, Property 1: Mobile token preferred over web-push
    let runs = 0;
    fc.assert(
      fc.property(
        devicesArb,
        fc.record({ onlineOnly: fc.boolean(), notificationType: fc.constantFrom(...ALL_TYPES) }),
        (devices, opts) => {
          runs += 1;
          // A device exposing BOTH a usable mobile token and a valid web-push sub.
          // The backend's only mobile transport is Expo, so the "usable mobile
          // token" is an ExponentPushToken (matching notify.resolveNotifyTarget);
          // a raw fcm/apns token would NOT be deliverable and must not count.
          const dual: FanoutDevice = {
            deviceId: 'INJECTED-DUAL',
            deviceType: 'web',
            isDeleted: false,
            isOnline: true,
            expoPushToken: 'ExponentPushToken[dual-unique]',
            // Raw fcm token present alongside the Expo token — it must be ignored
            // for delivery, never overriding the Expo mobile channel.
            fcmToken: 'dual-raw-fcm:APA91bDual',
            webPushSubscription: {
              endpoint: 'https://push.example/dual-unique',
              keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
            },
          };
          const ctx: FilterContext = {
            notificationType: opts.notificationType,
            allowWhenDisabled: true, // bypass toggles so the injected device survives
            onlineOnly: opts.onlineOnly,
            senderEmail: null, // no chat suppression
            nowMs: BASE_NOW,
            activeChatWindowMs: WINDOW,
          };
          const all = [...devices, dual];
          const out = applyDeliveryFilter(all, ctx);

          const injectedTarget = out.selected.find((t) => t.deviceId === 'INJECTED-DUAL');
          expect(injectedTarget).toBeDefined();
          expect(injectedTarget?.channel).toBe('mobile');

          // General invariant: any selected device with both a resolvable mobile
          // token AND a valid web-push subscription resolves to the mobile channel.
          const index = byId(all);
          for (const target of out.selected) {
            const device = index.get(target.deviceId)!;
            const hasMobile = !!resolvePreferredMobileToken(device);
            const hasWeb = !!sanitizeWebPushSubscription(device.webPushSubscription);
            if (hasMobile && hasWeb) {
              expect(target.channel).toBe('mobile');
            }
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 7: mobile-token deduplication delivers once per token', () => {
    // Feature: device-push-fanout-migration, Property 7: Mobile-token deduplication delivers once per token
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, (devices) => {
        runs += 1;
        const ctx: FilterContext = {
          notificationType: undefined,
          allowWhenDisabled: true,
          onlineOnly: false,
          senderEmail: null,
          nowMs: BASE_NOW,
          activeChatWindowMs: WINDOW,
        };
        const out = applyDeliveryFilter(devices, ctx);
        // The mobile token is the device's `expoPushToken` (the backend's only
        // mobile transport is Expo); devices sharing a mobile token share the same
        // `expoPushToken` (drawn from the small TOKENS pool in `deviceArb`).
        const mobileTokens = out.selected
          .filter((t) => t.channel === 'mobile')
          .map((t) => t.mobileToken!.token);
        // Even when several devices share a mobile token, each distinct token
        // appears in at most one selected mobile target.
        expect(new Set(mobileTokens).size).toBe(mobileTokens.length);
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });
});

// ---------------------------------------------------------------------------
// Notice-parity ban/logout exclusion (Property 18) — device-push-fanout-migration
//
// The notice fan-out (`services/noticeService.ts`) excludes hard-banned and
// manual/forced-logged-out devices before delivery (`evaluateDeviceEligibility`
// UNION `canAttemptRemoteNotificationDelivery` → `isDeviceLoggedOut`). The base
// Delivery_Filter does NOT, so `applyDeliveryFilter` gained the opt-in
// `excludeBannedOrLoggedOut` flag (set by `fanout` for `notice_created` only).
// These properties pin that new exclusion down for notice parity (Req 7.5) while
// confirming the flag defaults OFF (no chat/other-type regression).
// ---------------------------------------------------------------------------

// A ban/logout "condition" the client notice path excludes, expressed as the
// device fields that trigger it plus whether the device must be offline for it
// to apply. Each is exercised on a device that is otherwise fully deliverable.
const BAN_LOGOUT_CASES: Array<{ name: string; fields: Partial<FanoutDevice>; requiresOffline: boolean }> = [
  { name: 'isHardBanned', fields: { isHardBanned: true }, requiresOffline: false },
  { name: 'sessionActive=false', fields: { sessionActive: false }, requiresOffline: false },
  { name: "logoutType='manual'", fields: { logoutType: 'manual' }, requiresOffline: false },
  { name: "logoutType='forced'", fields: { logoutType: 'forced' }, requiresOffline: false },
  { name: "lastActivityType='logout'", fields: { lastActivityType: 'logout' }, requiresOffline: false },
  { name: "lastActivityType='forced_logout'", fields: { lastActivityType: 'forced_logout' }, requiresOffline: false },
  { name: 'offline+manualLogoutAt', fields: { manualLogoutAt: BASE_NOW - 60_000 }, requiresOffline: true },
  { name: 'offline+forcedLogoutAt', fields: { forcedLogoutAt: BASE_NOW - 60_000 }, requiresOffline: true },
];

// Reference predicate mirroring the implementation's `isDeviceBannedOrLoggedOut`,
// used to independently classify a generated device.
function refBannedOrLoggedOut(d: FanoutDevice): boolean {
  if (d.isHardBanned === true) return true;
  if (d.sessionActive === false) return true;
  if (d.logoutType === 'manual' || d.logoutType === 'forced') return true;
  if (d.lastActivityType === 'logout' || d.lastActivityType === 'forced_logout') return true;
  if (d.isOnline !== true) {
    const m = typeof d.manualLogoutAt === 'number' ? d.manualLogoutAt : 0;
    const f = typeof d.forcedLogoutAt === 'number' ? d.forcedLogoutAt : 0;
    if (m > 0 || f > 0) return true;
  }
  return false;
}

// Devices carrying random ban/logout state alongside the base fields, so the
// general invariant is exercised across mixed populations.
const banLogoutDeviceArb = fc
  .record({
    deviceType: fc.constantFrom('mobile', 'web', 'tablet', undefined),
    isDeleted: optionalBool,
    isOnline: optionalBool,
    isHardBanned: optionalBool,
    sessionActive: optionalBool,
    logoutType: fc.constantFrom('manual', 'forced', 'auto', undefined),
    lastActivityType: fc.constantFrom('logout', 'forced_logout', 'login', 'heartbeat', undefined),
    manualLogoutAt: fc.option(fc.integer({ min: BASE_NOW - 600_000, max: BASE_NOW }), { nil: undefined }),
    forcedLogoutAt: fc.option(fc.integer({ min: BASE_NOW - 600_000, max: BASE_NOW }), { nil: undefined }),
    apnsToken: fc.option(fc.constantFrom(...TOKENS), { nil: undefined }),
    expoPushToken: fc.option(fc.constantFrom(...TOKENS), { nil: undefined }),
    webPushSubscription: webSubArb,
    notificationsEnabled: optionalBool,
    noticeNotificationsEnabled: optionalBool,
  })
  .map((d) => d as FanoutDevice);

const banLogoutDevicesArb = fc
  .array(banLogoutDeviceArb, { maxLength: 8 })
  .map((list) => list.map((d, i): FanoutDevice => ({ ...(d as FanoutDevice), deviceId: `bl-${i}` })));

describe('applyDeliveryFilter — notice-parity ban/logout exclusion', () => {
  it('Property 18: excludeBannedOrLoggedOut excludes hard-banned / logged-out devices (notice parity)', () => {
    // Feature: device-push-fanout-migration, Property 18: When excludeBannedOrLoggedOut is set, hard-banned and manual/forced-logged-out devices are never selected (notice parity), and the flag defaults OFF for every other fan-out
    // Part A — per-condition injected device: fully deliverable EXCEPT the one
    // ban/logout condition. With the flag ON it must be excluded; with the flag
    // OFF (the chat/other-type default) it must survive — proving the flag both
    // enforces notice parity and is a no-op for every other fan-out.
    for (const { name, fields, requiresOffline } of BAN_LOGOUT_CASES) {
      let runs = 0;
      fc.assert(
        fc.property(banLogoutDevicesArb, fc.constantFrom(...ALL_TYPES), (devices, notificationType) => {
          runs += 1;
          const injected: FanoutDevice = {
            deviceId: `INJECTED-${name}`,
            deviceType: 'mobile',
            isDeleted: false,
            isOnline: requiresOffline ? false : true,
            notificationsEnabled: true,
            chatNotificationsEnabled: true,
            noticeNotificationsEnabled: true,
            teamNotificationsEnabled: true,
            dailyQuotesEnabled: true,
            // Deliverable via the backend's only mobile transport (Expo), so with
            // the flag OFF the device genuinely survives as a mobile target; a
            // unique token so it is never removed by dedup.
            expoPushToken: `ExponentPushToken[unique-${name}]`,
            ...fields,
          };
          const base = {
            notificationType,
            allowWhenDisabled: true, // prove the exclusion is NOT a Per_Type_Toggle
            // requiresOffline cases need offline devices admitted, so onlineOnly must be off.
            onlineOnly: false,
            senderEmail: null, // no chat suppression
            nowMs: BASE_NOW,
            activeChatWindowMs: WINDOW,
          };

          const excluded = applyDeliveryFilter([...devices, injected], {
            ...base,
            excludeBannedOrLoggedOut: true,
          } as FilterContext);
          expect(excluded.selected.some((t) => t.deviceId === injected.deviceId)).toBe(false);

          // Flag OFF (default for chat/team/daily-quote): the exact same device
          // survives, so the flag is a strict, opt-in strengthening.
          const included = applyDeliveryFilter([...devices, injected], {
            ...base,
            excludeBannedOrLoggedOut: false,
          } as FilterContext);
          expect(included.selected.some((t) => t.deviceId === injected.deviceId)).toBe(true);
        }),
        { numRuns: NUM_RUNS }
      );
      expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
    }

    // Part B — general invariant over mixed populations: with the flag ON, no
    // selected device is classified banned/logged-out by the reference predicate.
    let generalRuns = 0;
    fc.assert(
      fc.property(banLogoutDevicesArb, fc.constantFrom(...ALL_TYPES), fc.boolean(), (devices, notificationType, onlineOnly) => {
        generalRuns += 1;
        const out = applyDeliveryFilter(devices, {
          notificationType,
          allowWhenDisabled: true,
          onlineOnly,
          senderEmail: null,
          nowMs: BASE_NOW,
          activeChatWindowMs: WINDOW,
          excludeBannedOrLoggedOut: true,
        } as FilterContext);
        const index = byId(devices);
        for (const target of out.selected) {
          const device = index.get(target.deviceId)!;
          expect(refBannedOrLoggedOut(device)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS }
    );
    expect(generalRuns).toBeGreaterThanOrEqual(NUM_RUNS);
  });
});

// ---------------------------------------------------------------------------
// Single-device targeting (Property 19) — device-push-fanout-migration Part B
//
// The client single-device push path (`sendNotificationToDeviceDetailed`) routes
// through `POST /notifications/fanout` with a `deviceId`, which `fanout()`
// forwards as `FilterContext.targetDeviceId`. When set, the Delivery_Filter must
// restrict its candidate set to the ONE matching device BEFORE any other rule, so
// the selection is always a subset of `{ targetDevice }`. These properties pin
// that restriction down while confirming it is a no-op when unset (Properties
// 1–18 unchanged).
// ---------------------------------------------------------------------------

describe('applyDeliveryFilter — single-device targeting', () => {
  it('Property 19: targetDeviceId restricts the selection to that single device', () => {
    // Feature: device-push-fanout-migration, Property 19: When targetDeviceId is set, every selected device has that id (selection is a subset of {targetDevice}), and an absent/non-matching id yields no selection
    let runs = 0;
    fc.assert(
      fc.property(
        devicesArb,
        // Pick a target from the generated ids (a real device) OR an id that does
        // not exist (`gen-absent`), so both the matching and non-matching cases
        // are exercised.
        fc.oneof(
          fc.integer({ min: 0, max: 7 }).map((i) => `gen-${i}`),
          fc.constant('gen-absent')
        ),
        ctxArb,
        (devices, targetDeviceId, ctxPartial) => {
          runs += 1;
          const ctx: FilterContext = { ...ctxPartial, targetDeviceId };
          const out = applyDeliveryFilter(devices, ctx);

          // Every selected device is the target device (selection ⊆ {target}).
          for (const target of out.selected) {
            expect(target.deviceId).toBe(targetDeviceId);
          }
          // At most one device can ever be selected for a single-device target.
          expect(out.selected.length).toBeLessThanOrEqual(1);

          // A target id absent from the candidate set selects nothing (and is
          // never suppressed into a selection either).
          const targetExists = devices.some((d) => d.deviceId === targetDeviceId);
          if (!targetExists) {
            expect(out.selected).toHaveLength(0);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 19 (no-op): an unset targetDeviceId leaves the selection unchanged', () => {
    // Feature: device-push-fanout-migration, Property 19: An absent targetDeviceId is a no-op — the filter considers every candidate device (Properties 1-18 unchanged)
    let runs = 0;
    fc.assert(
      fc.property(devicesArb, ctxArb, (devices, ctx) => {
        runs += 1;
        const withoutTarget = applyDeliveryFilter(devices, ctx);
        const withBlankTarget = applyDeliveryFilter(devices, { ...ctx, targetDeviceId: '   ' });
        // A blank/whitespace target is treated as unset — identical selection.
        expect(normSelected(withBlankTarget)).toEqual(normSelected(withoutTarget));
        expect(withBlankTarget.suppressed).toBe(withoutTarget.suppressed);
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });
});
