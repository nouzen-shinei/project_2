// Feature: device-console-migration, Property 6: Filter membership correctness (including hide-inactive)

/**
 * Property 6: Filter membership correctness (including hide-inactive)
 * **Validates: Requirements 5.1, 5.5**
 *
 * For any device and any filter among
 * `all | online | offline | web | mobile | tablet | deleted | logged_out |
 * force_logged_out | hard_banned`, `matchesFilter(device, filter, nowMs)`
 * returns `true` iff the device satisfies that filter (Requirement 5.1); and
 * the hide-inactive predicate `isInactiveDevice(device)` returns `true` exactly
 * when a device is deleted, hard banned, or (broadly) logged out — i.e. the
 * devices the "Hide inactive devices" toggle excludes (Requirement 5.5).
 *
 * The test drives the real `matchesFilter` / `isInactiveDevice` helpers exported
 * from `deviceAdminService.ts` against an independent oracle (no mocking, no
 * Firestore), across hundreds of generated devices whose `deviceType`,
 * `lastSeenMs` / `lastSeen` (clustered around the 300000 ms window boundary),
 * `isDeleted`, `isHardBanned`, `logoutType`, `lastActivityType`,
 * `sessionActive`, and `forcedLogout*` fields vary widely.
 */

import * as fc from 'fast-check';

import {
  matchesFilter,
  isInactiveDevice,
  type DeviceAdminRecord,
  type DeviceFilter,
} from '../deviceAdminService';

// The console online window under test (Requirement 1.6, reused by the
// online/offline filters in Requirement 5.1): 300 seconds in ms.
const WINDOW_MS = 300_000;

// Arbitrary fixed epoch-ms reference the generators cluster around, so that
// `nowMs - lastSeenMs` straddles the 300000 ms boundary in both directions.
const BASE_MS = 1_700_000_000_000;

// The complete filter set the Device Console offers (Requirement 5.1).
const ALL_FILTERS: DeviceFilter[] = [
  'all',
  'online',
  'offline',
  'web',
  'mobile',
  'tablet',
  'deleted',
  'logged_out',
  'force_logged_out',
  'hard_banned',
];

// ---------------------------------------------------------------------------
// Independent oracle (deliberately re-derived, not importing the production
// predicates, so the test cross-checks behavior rather than restating it).
// ---------------------------------------------------------------------------

/** Resolve last-seen epoch-ms: prefer finite `lastSeenMs`, else parse ISO `lastSeen`. */
function resolveLastSeenMsOracle(device: DeviceAdminRecord): number {
  if (typeof device.lastSeenMs === 'number' && Number.isFinite(device.lastSeenMs)) {
    return device.lastSeenMs;
  }
  if (typeof device.lastSeen === 'string' && device.lastSeen.trim().length > 0) {
    const parsed = Date.parse(device.lastSeen);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

/** Online iff last-seen and now are finite and `now - lastSeen <= 300000`. */
function classifyOnlineOracle(device: DeviceAdminRecord, nowMs: number): boolean {
  const ms = resolveLastSeenMsOracle(device);
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) {
    return false;
  }
  return nowMs - ms <= WINDOW_MS;
}

/** Broad logged-out: inactive session, any logoutType, or a logout activity. */
function isBroadlyLoggedOutOracle(device: DeviceAdminRecord): boolean {
  if (device.sessionActive === false) {
    return true;
  }
  if (
    device.logoutType === 'manual' ||
    device.logoutType === 'forced' ||
    device.logoutType === 'auto'
  ) {
    return true;
  }
  return device.lastActivityType === 'logout' || device.lastActivityType === 'forced_logout';
}

/** Narrow logged-out (manual/auto, non-forced) — the `logged_out` filter. */
function isManualOrAutoLoggedOutOracle(device: DeviceAdminRecord): boolean {
  if (device.logoutType === 'manual' || device.logoutType === 'auto') {
    return true;
  }
  return device.lastActivityType === 'logout';
}

/** Force logged-out — the `force_logged_out` filter (incl. provenance fields). */
function isForceLoggedOutOracle(device: DeviceAdminRecord): boolean {
  if (device.logoutType === 'forced') {
    return true;
  }
  if (device.lastActivityType === 'forced_logout') {
    return true;
  }
  if (typeof device.forcedLogoutBy === 'string' && device.forcedLogoutBy.trim().length > 0) {
    return true;
  }
  if (typeof device.forcedLogoutAt === 'string' && device.forcedLogoutAt.trim().length > 0) {
    return true;
  }
  return false;
}

/** Oracle for `matchesFilter` (Requirement 5.1). */
function matchesFilterOracle(
  device: DeviceAdminRecord,
  filter: DeviceFilter,
  nowMs: number
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'online':
      // Deleted / hard-banned devices are never online (they match offline),
      // keeping the filter consistent with `computeCounts`.
      return (
        device.isDeleted !== true &&
        device.isHardBanned !== true &&
        classifyOnlineOracle(device, nowMs)
      );
    case 'offline':
      return !(
        device.isDeleted !== true &&
        device.isHardBanned !== true &&
        classifyOnlineOracle(device, nowMs)
      );
    case 'web':
      return device.deviceType === 'web';
    case 'mobile':
      return device.deviceType === 'mobile';
    case 'tablet':
      return device.deviceType === 'tablet';
    case 'deleted':
      return device.isDeleted === true;
    case 'logged_out':
      return isManualOrAutoLoggedOutOracle(device);
    case 'force_logged_out':
      return isForceLoggedOutOracle(device);
    case 'hard_banned':
      return device.isHardBanned === true;
    default:
      return false;
  }
}

/** Oracle for `isInactiveDevice` (Requirement 5.5). */
function isInactiveDeviceOracle(device: DeviceAdminRecord): boolean {
  return (
    device.isDeleted === true ||
    device.isHardBanned === true ||
    isBroadlyLoggedOutOracle(device)
  );
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Finite epoch-ms clustered around the reference so `now - lastSeen` lands on
// both sides of the 300000 ms window (range ±1e6 ms ≈ ±16.7 min).
const finiteMsArb = fc.integer({ min: BASE_MS - 1_000_000, max: BASE_MS + 1_000_000 });

/** `lastSeenMs`: finite near the boundary, or a missing/invalid variant. */
const lastSeenMsArb = fc.oneof(
  finiteMsArb,
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(undefined),
  fc.constant(null)
);

/** `lastSeen`: a valid ISO string, or a missing/invalid variant. */
const lastSeenArb = fc.oneof(
  finiteMsArb.map((ms) => new Date(ms).toISOString()),
  fc.constant('not-a-real-timestamp'),
  fc.constant(''),
  fc.constant('   '),
  fc.constant(undefined),
  fc.constant(null)
);

const deviceTypeArb = fc.option(fc.constantFrom('mobile', 'web', 'tablet' as const), {
  nil: undefined,
});
const logoutTypeArb = fc.option(fc.constantFrom('manual', 'forced', 'auto' as const), {
  nil: undefined,
});
// Includes both logout activities and non-logout activities so the narrow /
// broad logged-out predicates are exercised in both directions.
const lastActivityTypeArb = fc.option(
  fc.constantFrom('logout', 'forced_logout', 'login', 'heartbeat', 'active'),
  { nil: undefined }
);
const optionalBoolArb = fc.option(fc.boolean(), { nil: undefined });

// Includes empty and whitespace-only strings to exercise the `.trim().length`
// gate on the force-logout provenance fields.
const forcedLogoutByArb = fc.option(
  fc.constantFrom('admin@example.com', 'system', 'op-123', '', '   '),
  { nil: undefined }
);
const forcedLogoutAtArb = fc.option(
  fc.constantFrom(new Date(BASE_MS).toISOString(), 'not-a-date', '', '   '),
  { nil: undefined }
);

const deviceArb: fc.Arbitrary<DeviceAdminRecord> = fc.record(
  {
    deviceId: fc.string({ minLength: 1, maxLength: 12 }),
    deviceType: deviceTypeArb,
    lastSeen: lastSeenArb,
    lastSeenMs: lastSeenMsArb,
    isDeleted: optionalBoolArb,
    isHardBanned: optionalBoolArb,
    sessionActive: optionalBoolArb,
    logoutType: logoutTypeArb,
    lastActivityType: lastActivityTypeArb,
    forcedLogoutBy: forcedLogoutByArb,
    forcedLogoutAt: forcedLogoutAtArb,
  },
  { requiredKeys: ['deviceId'] }
) as fc.Arbitrary<DeviceAdminRecord>;

/** `nowMs`: finite near the boundary, plus non-finite values to tolerate. */
const nowMsArb = fc.oneof(
  finiteMsArb,
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY)
);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 6 — filter membership correctness (including hide-inactive)', () => {
  it(
    'matchesFilter agrees with an independent oracle for every one of the ten filters (property)',
    () => {
      fc.assert(
        fc.property(deviceArb, nowMsArb, (device, nowMs) => {
          // Every device is checked against all ten filters so each filter is
          // exercised on every generated input.
          for (const filter of ALL_FILTERS) {
            expect(matchesFilter(device, filter, nowMs)).toBe(
              matchesFilterOracle(device, filter, nowMs)
            );
          }
        }),
        { numRuns: 300, verbose: false }
      );
    },
    30_000
  );

  it(
    'online and offline filters partition every device at the 300000 ms window (property)',
    () => {
      fc.assert(
        fc.property(
          deviceArb,
          // Deltas concentrated on the 300000 ms boundary plus a wider spread,
          // applied relative to a finite reference so online/offline flip here.
          fc.oneof(
            fc.integer({ min: WINDOW_MS - 5, max: WINDOW_MS + 5 }),
            fc.integer({ min: -10, max: 10 }),
            fc.integer({ min: -1_000_000, max: 1_000_000 })
          ),
          (device, delta) => {
            const nowMs = BASE_MS + delta;
            // Force a finite, known last-seen so the boundary is deterministic,
            // and clear the deleted/banned flags so this case isolates the 300s
            // window split (the deleted/banned exclusion is covered separately).
            const boundaryDevice: DeviceAdminRecord = {
              ...device,
              lastSeenMs: BASE_MS,
              lastSeen: undefined,
              isDeleted: false,
              isHardBanned: false,
            };
            const expectedOnline = delta <= WINDOW_MS;
            expect(matchesFilter(boundaryDevice, 'online', nowMs)).toBe(expectedOnline);
            expect(matchesFilter(boundaryDevice, 'offline', nowMs)).toBe(!expectedOnline);
          }
        ),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  it(
    'isInactiveDevice agrees with the deleted / hard-banned / logged-out oracle (property)',
    () => {
      fc.assert(
        fc.property(deviceArb, (device) => {
          expect(isInactiveDevice(device)).toBe(isInactiveDeviceOracle(device));
        }),
        { numRuns: 300, verbose: false }
      );
    },
    30_000
  );

  it(
    'hide-inactive excludes deleted, hard-banned, and logged-out devices, and keeps active ones (property)',
    () => {
      fc.assert(
        fc.property(deviceArb, (base) => {
          // Deleted → inactive.
          expect(isInactiveDevice({ ...base, isDeleted: true })).toBe(true);
          // Hard banned → inactive.
          expect(isInactiveDevice({ ...base, isHardBanned: true })).toBe(true);
          // Logged out (any logout kind / inactive session) → inactive.
          expect(isInactiveDevice({ ...base, logoutType: 'manual' })).toBe(true);
          expect(isInactiveDevice({ ...base, logoutType: 'auto' })).toBe(true);
          expect(isInactiveDevice({ ...base, logoutType: 'forced' })).toBe(true);
          expect(isInactiveDevice({ ...base, sessionActive: false })).toBe(true);
          expect(isInactiveDevice({ ...base, lastActivityType: 'logout' })).toBe(true);
          expect(isInactiveDevice({ ...base, lastActivityType: 'forced_logout' })).toBe(true);

          // A fully active device (none of the inactive conditions) is kept.
          const active: DeviceAdminRecord = {
            deviceId: base.deviceId || 'd',
            deviceType: 'mobile',
            isDeleted: false,
            isHardBanned: false,
            sessionActive: true,
            logoutType: undefined,
            lastActivityType: 'active',
          };
          expect(isInactiveDevice(active)).toBe(false);
        }),
        { numRuns: 100, verbose: false }
      );
    },
    20_000
  );

  it(
    'devices matching deleted / hard_banned / logged_out filters are hidden by hide-inactive (property)',
    () => {
      fc.assert(
        fc.property(deviceArb, nowMsArb, (device, nowMs) => {
          // Requirement 5.5: everything the deleted, hard_banned, and logged_out
          // filters surface is inactive, so hide-inactive removes it.
          if (matchesFilter(device, 'deleted', nowMs)) {
            expect(isInactiveDevice(device)).toBe(true);
          }
          if (matchesFilter(device, 'hard_banned', nowMs)) {
            expect(isInactiveDevice(device)).toBe(true);
          }
          if (matchesFilter(device, 'logged_out', nowMs)) {
            expect(isInactiveDevice(device)).toBe(true);
          }
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  it(
    'a deleted or hard-banned device with a fresh lastSeen matches offline, not online (property)',
    () => {
      fc.assert(
        fc.property(
          deviceArb,
          // A delta inside the window so, absent the deleted/banned exclusion,
          // the device would classify as online purely on lastSeen.
          fc.integer({ min: 0, max: WINDOW_MS }),
          fc.constantFrom('deleted', 'hardBanned', 'both' as const),
          (device, delta, mode) => {
            const nowMs = BASE_MS + delta;
            const fresh: DeviceAdminRecord = {
              ...device,
              lastSeenMs: BASE_MS,
              lastSeen: undefined,
              isDeleted: mode === 'deleted' || mode === 'both',
              isHardBanned: mode === 'hardBanned' || mode === 'both',
            };
            // Deleted/banned ⇒ never online (matches offline), even though the
            // 300s window alone would say online — consistent with computeCounts.
            expect(matchesFilter(fresh, 'online', nowMs)).toBe(false);
            expect(matchesFilter(fresh, 'offline', nowMs)).toBe(true);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );
});
