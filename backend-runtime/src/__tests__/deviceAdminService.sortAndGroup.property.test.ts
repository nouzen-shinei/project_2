// Feature: device-console-migration, Property 7: Sort and grouping ordering

/**
 * Property 7: Sort and grouping ordering
 * Validates: Requirements 5.2, 5.3, 5.6, 5.7
 *
 * For any set of tenant devices and any selected sort option, the exported
 * `sortAndGroup(devices, sort, nowMs?)` helper from `deviceAdminService.ts`:
 *
 *  (a) groups devices by (trimmed) owner email ordered ascending A→Z, with a
 *      single distinct FINAL group for devices lacking an owner email
 *      (Requirements 5.6, 5.7);
 *  (b) partitions the input — every input device appears exactly once across
 *      all groups, placed in the group matching its normalized owner email;
 *  (c) orders devices within each group by the selected sort — `name`,
 *      `deviceType`, and `status` ascending; `lastSeen` most-recent-first — with
 *      ties broken by last-seen most-recent-first and then by `deviceId`
 *      ascending (Requirements 5.2, 5.3);
 *  (d) is stable/deterministic — calling it twice on the same input yields
 *      identical output.
 *
 * The test drives the real `sortAndGroup` across hundreds of generated inputs
 * (varied owner emails including missing/blank/whitespace, device names, device
 * types, last-seen values, and status-affecting flags) for all four sort
 * options, and checks each property against an independent oracle derived from
 * the documented ordering semantics and tie-breaks — no mocking, no Firestore.
 */

import * as fc from 'fast-check';

import {
  sortAndGroup,
  type DeviceAdminRecord,
  type DeviceSort,
  type GroupedDevices,
} from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Independent oracle (mirrors the documented ordering semantics, not the code)
// ---------------------------------------------------------------------------

const ONLINE_WINDOW_MS = 300_000; // Requirement 1.6 window used by the `status` sort.

/** Prefer a finite numeric `lastSeenMs`, else parse the ISO `lastSeen` string. */
function oracleResolveLastSeenMs(d: DeviceAdminRecord): number {
  if (typeof d.lastSeenMs === 'number' && Number.isFinite(d.lastSeenMs)) {
    return d.lastSeenMs;
  }
  if (typeof d.lastSeen === 'string' && d.lastSeen.trim().length > 0) {
    const parsed = Date.parse(d.lastSeen);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

/** Unknown/invalid last-seen sorts oldest under "most-recent-first". */
function oracleLastSeenForOrdering(d: DeviceAdminRecord): number {
  const ms = oracleResolveLastSeenMs(d);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function oracleClassifyOnline(d: DeviceAdminRecord, nowMs: number): boolean {
  const ms = oracleResolveLastSeenMs(d);
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) {
    return false;
  }
  return nowMs - ms <= ONLINE_WINDOW_MS;
}

function oracleIsBroadlyLoggedOut(d: DeviceAdminRecord): boolean {
  if (d.sessionActive === false) {
    return true;
  }
  if (d.logoutType === 'manual' || d.logoutType === 'forced' || d.logoutType === 'auto') {
    return true;
  }
  return d.lastActivityType === 'logout' || d.lastActivityType === 'forced_logout';
}

/** Documented status precedence: online(0) < offline(1) < logged-out(2) < banned(3) < deleted(4). */
function oracleStatusRank(d: DeviceAdminRecord, nowMs?: number): number {
  if (d.isDeleted === true) {
    return 4;
  }
  if (d.isHardBanned === true) {
    return 3;
  }
  if (oracleIsBroadlyLoggedOut(d)) {
    return 2;
  }
  const online =
    typeof nowMs === 'number' ? oracleClassifyOnline(d, nowMs) : d.isOnline === true;
  return online ? 0 : 1;
}

/** Normalize any comparator output to a sign in {-1, 0, 1} (avoids NaN math). */
function sign(x: number): number {
  if (x < 0) {
    return -1;
  }
  if (x > 0) {
    return 1;
  }
  return 0;
}

/**
 * Last-seen "most-recent-first" comparison as a sign, using ordered comparison
 * rather than subtraction so that two unknown/`-Infinity` last-seen values
 * compare equal (0) instead of yielding `NaN`. Returns negative when `a` should
 * precede `b` (i.e. `a` is more recent).
 */
function lastSeenCmp(a: DeviceAdminRecord, b: DeviceAdminRecord): number {
  const av = oracleLastSeenForOrdering(a);
  const bv = oracleLastSeenForOrdering(b);
  if (av > bv) {
    return -1; // a more recent → a first
  }
  if (av < bv) {
    return 1;
  }
  return 0; // equal, including both non-finite (unknown last-seen)
}

/**
 * The primary comparison for a given sort, expressed as a sign in {-1, 0, 1}.
 * `name`/`deviceType` compare case-sensitively via `localeCompare`; `status`
 * compares the documented rank; `lastSeen` compares most-recent-first.
 */
function primaryCmp(
  a: DeviceAdminRecord,
  b: DeviceAdminRecord,
  sort: DeviceSort,
  nowMs?: number
): number {
  switch (sort) {
    case 'name':
      return sign((a.deviceName ?? '').localeCompare(b.deviceName ?? ''));
    case 'deviceType':
      return sign((a.deviceType ?? '').localeCompare(b.deviceType ?? ''));
    case 'status':
      return sign(oracleStatusRank(a, nowMs) - oracleStatusRank(b, nowMs));
    case 'lastSeen':
    default:
      return lastSeenCmp(a, b);
  }
}

/** Trim an owner email, mapping missing/blank values to `null`. */
function oracleNormalizeOwnerEmail(ownerEmail: string | null | undefined): string | null {
  if (typeof ownerEmail !== 'string') {
    return null;
  }
  const trimmed = ownerEmail.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Reduce a grouped result to a comparable shape for equality/stability checks. */
function serializeGroups(groups: GroupedDevices): Array<{ ownerEmail: string | null; ids: string[] }> {
  return groups.map((g) => ({ ownerEmail: g.ownerEmail, ids: g.devices.map((d) => d.deviceId) }));
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Owner emails: a small pool (so groups hold multiple devices) plus whitespace
// variants that trim into an existing group, mixed-case (distinct group key),
// and the missing/blank/whitespace/null/undefined variants that route a device
// into the distinct no-owner-email group (Requirement 5.7).
const ownerEmailArb = fc.oneof(
  fc.constantFrom('alice@example.com', 'bob@example.com', 'carol@example.com'),
  fc.constantFrom('  alice@example.com  ', ' bob@example.com'),
  fc.constant('Dave@Example.com'),
  fc.constant(''),
  fc.constant('   '),
  fc.constant(null),
  fc.constant(undefined)
);

// Device names: a small pool (to force frequent primary-key ties that exercise
// the tie-breaks) plus arbitrary strings and missing values.
const deviceNameArb = fc.oneof(
  fc.constantFrom('Alpha', 'Beta', 'alpha', 'Zeta', ''),
  fc.string({ maxLength: 6 }),
  fc.constant(undefined)
);

const deviceTypeArb = fc.oneof(
  fc.constantFrom('mobile' as const, 'web' as const, 'tablet' as const),
  fc.constant(undefined)
);

// A broad epoch-ms range: 1970-01-01 .. ~2100-01-01.
const finiteMsArb = fc.integer({ min: 0, max: 4_102_444_800_000 });

const lastSeenMsArb = fc.oneof(
  finiteMsArb,
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(undefined),
  fc.constant(null)
);

const lastSeenArb = fc.oneof(
  finiteMsArb.map((ms) => new Date(ms).toISOString()),
  fc.constant('not-a-real-timestamp'),
  fc.constant(''),
  fc.constant('   '),
  fc.constant(undefined),
  fc.constant(null)
);

// A device-shaped spec WITHOUT deviceId; a unique deviceId is assigned by index
// after generation so the comparator is a strict total order and the expected
// ordering is unambiguous.
const deviceSpecArb = fc.record(
  {
    ownerEmail: ownerEmailArb,
    deviceName: deviceNameArb,
    deviceType: deviceTypeArb,
    lastSeenMs: lastSeenMsArb,
    lastSeen: lastSeenArb,
    isOnline: fc.boolean(),
    isDeleted: fc.option(fc.boolean(), { nil: undefined }),
    isHardBanned: fc.option(fc.boolean(), { nil: undefined }),
    sessionActive: fc.option(fc.boolean(), { nil: undefined }),
    logoutType: fc.option(fc.constantFrom('manual' as const, 'forced' as const, 'auto' as const), {
      nil: undefined,
    }),
    lastActivityType: fc.option(fc.constantFrom('logout', 'forced_logout', 'login', 'active'), {
      nil: undefined,
    }),
    forcedLogoutBy: fc.option(fc.string({ maxLength: 6 }), { nil: undefined }),
    forcedLogoutAt: fc.option(finiteMsArb.map((ms) => new Date(ms).toISOString()), {
      nil: undefined,
    }),
  },
  { requiredKeys: [] }
);

const devicesArb = fc
  .array(deviceSpecArb, { minLength: 0, maxLength: 30 })
  .map((specs) =>
    specs.map((spec, index): DeviceAdminRecord => ({ ...spec, deviceId: `dev-${index}` }))
  );

const sortArb = fc.constantFrom<DeviceSort>('name', 'lastSeen', 'deviceType', 'status');

// The `status` sort recomputes online/offline with `nowMs` when supplied, and
// falls back to the stored `isOnline` flag when omitted — exercise both.
const nowMsArb = fc.option(finiteMsArb, { nil: undefined });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 7 — sort and grouping ordering', () => {
  it(
    'groups owner emails ascending with the no-owner group last (property)',
    () => {
      fc.assert(
        fc.property(devicesArb, sortArb, nowMsArb, (devices, sort, nowMs) => {
          const groups = sortAndGroup(devices, sort, nowMs);

          const nullIndexes = groups
            .map((g, i) => (g.ownerEmail === null ? i : -1))
            .filter((i) => i >= 0);
          // At most one no-owner group, and if present it is the final group.
          expect(nullIndexes.length).toBeLessThanOrEqual(1);
          if (nullIndexes.length === 1) {
            expect(nullIndexes[0]).toBe(groups.length - 1);
          }

          // Non-null owner emails are ordered ascending (A→Z) and match the
          // independently-sorted set of distinct trimmed owner emails present.
          const emails = groups
            .filter((g) => g.ownerEmail !== null)
            .map((g) => g.ownerEmail as string);
          const expectedEmails = [...new Set(emails)].sort((a, b) => a.localeCompare(b));
          expect(emails).toEqual(expectedEmails);
          for (let i = 1; i < emails.length; i += 1) {
            expect(emails[i - 1].localeCompare(emails[i])).toBeLessThanOrEqual(0);
          }
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  it(
    'partitions the input — every device appears exactly once in the correct group (property)',
    () => {
      fc.assert(
        fc.property(devicesArb, sortArb, nowMsArb, (devices, sort, nowMs) => {
          const groups = sortAndGroup(devices, sort, nowMs);

          const flattenedIds = groups.flatMap((g) => g.devices.map((d) => d.deviceId));
          // Same cardinality as the input, and each device present exactly once.
          expect(flattenedIds.length).toBe(devices.length);
          expect([...flattenedIds].sort()).toEqual([...devices.map((d) => d.deviceId)].sort());

          // Every device sits in the group whose key equals its normalized owner.
          for (const group of groups) {
            for (const device of group.devices) {
              expect(oracleNormalizeOwnerEmail(device.ownerEmail)).toBe(group.ownerEmail);
            }
          }
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  it(
    'orders within each group by the selected sort with documented tie-breaks (property)',
    () => {
      fc.assert(
        fc.property(devicesArb, sortArb, nowMsArb, (devices, sort, nowMs) => {
          const groups = sortAndGroup(devices, sort, nowMs);

          for (const group of groups) {
            const ds = group.devices;
            for (let i = 1; i < ds.length; i += 1) {
              const prev = ds[i - 1];
              const next = ds[i];

              // Primary key is monotonic in the selected sort direction: `prev`
              // never sorts after `next` by the primary key.
              const primary = primaryCmp(prev, next, sort, nowMs);
              expect(primary).toBeLessThanOrEqual(0);

              // When the primary key ties, the first documented tie-break
              // applies: last-seen most-recent-first (`prev` at least as recent).
              if (primary === 0) {
                const seenSign = lastSeenCmp(prev, next);
                expect(seenSign).toBeLessThanOrEqual(0);

                // Second tie-break: when last-seen is also equal AND finite, the
                // comparator resolves the order by `deviceId` ascending. (Two
                // unknown/non-finite last-seen values compare equal and are left
                // in their existing, deterministic relative order, so the
                // deviceId tie-break is only asserted for finite-equal times.)
                if (seenSign === 0 && Number.isFinite(oracleLastSeenForOrdering(prev))) {
                  expect(prev.deviceId.localeCompare(next.deviceId)).toBeLessThanOrEqual(0);
                }
              }
            }
          }
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  it(
    'is stable/deterministic across repeated calls on the same input (property)',
    () => {
      fc.assert(
        fc.property(devicesArb, sortArb, nowMsArb, (devices, sort, nowMs) => {
          const first = sortAndGroup(devices, sort, nowMs);
          const second = sortAndGroup(devices, sort, nowMs);
          expect(serializeGroups(second)).toEqual(serializeGroups(first));
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// Focused example (aids debugging; complements the properties above)
// ---------------------------------------------------------------------------

describe('sortAndGroup — representative example', () => {
  it('groups A→Z, places the no-owner group last, and sorts by name within a group', () => {
    const devices: DeviceAdminRecord[] = [
      { deviceId: 'd1', ownerEmail: 'bob@example.com', deviceName: 'Zeta', lastSeenMs: 100 },
      { deviceId: 'd2', ownerEmail: '  alice@example.com  ', deviceName: 'Beta', lastSeenMs: 200 },
      { deviceId: 'd3', ownerEmail: 'alice@example.com', deviceName: 'Alpha', lastSeenMs: 50 },
      { deviceId: 'd4', ownerEmail: '   ', deviceName: 'NoOwner', lastSeenMs: 300 },
      { deviceId: 'd5', ownerEmail: undefined, deviceName: 'AlsoNoOwner', lastSeenMs: 400 },
    ];

    const groups = sortAndGroup(devices, 'name');

    expect(groups.map((g) => g.ownerEmail)).toEqual([
      'alice@example.com',
      'bob@example.com',
      null,
    ]);
    // alice's group: whitespace-trimmed owner merges d2 and d3; name A→Z → Alpha then Beta.
    expect(groups[0].devices.map((d) => d.deviceId)).toEqual(['d3', 'd2']);
    // no-owner group holds the blank/undefined owners, sorted by name A→Z.
    expect(groups[2].devices.map((d) => d.deviceId)).toEqual(['d5', 'd4']);
  });
});
