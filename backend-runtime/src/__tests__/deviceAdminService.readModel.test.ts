/**
 * Unit tests for Device Console read-model pure helpers (Task 1.8).
 *
 * Example-based, table-driven coverage of the edge cases called out by the task
 * for the pure helpers in `deviceAdminService.ts`. These complement the
 * property-based tests (Properties 1, 2, 5, 6, 7) by pinning down concrete
 * boundary examples and specific representative inputs:
 *
 *   - `classifyOnline` at the 299s / 300s / 301s boundary relative to a fixed `now`.
 *   - `matchesFilter` for each of the ten filter values, with a representative
 *     matching device and a representative non-matching device.
 *   - `matchesSearch` with accented characters and leading/trailing whitespace terms.
 *   - `sortAndGroup` producing the distinct "No owner email" final group.
 *   - The empty-filter-result / no-match cases.
 *
 * Requirements: 4.4, 5.4, 5.7
 *
 * The real, exported helpers are imported and exercised directly (no mocking,
 * no Firestore). `deviceAdminService.ts` is not modified by this task.
 */

import {
  classifyOnline,
  matchesFilter,
  matchesSearch,
  sortAndGroup,
} from '../deviceAdminService';
import type { DeviceAdminRecord, DeviceFilter } from '../deviceAdminService';

// A single fixed reference "now" (epoch ms) shared across the boundary and
// filter tables so every case is deterministic and clock-independent.
const NOW = 1_700_000_000_000;

/** Build a device record, overriding only the fields a case cares about. */
function makeDevice(overrides: Partial<DeviceAdminRecord> = {}): DeviceAdminRecord {
  return { deviceId: 'device-default', ...overrides };
}

// ---------------------------------------------------------------------------
// classifyOnline — 299s / 300s / 301s boundary at a fixed `now`
// ---------------------------------------------------------------------------

describe('classifyOnline — 299s / 300s / 301s boundary at a fixed now', () => {
  const boundaryCases: Array<{ label: string; deltaSeconds: number; expected: boolean }> = [
    { label: '299s ago → online (inside the 300s window)', deltaSeconds: 299, expected: true },
    { label: '300s ago → online (inclusive boundary)', deltaSeconds: 300, expected: true },
    { label: '301s ago → offline (just past the window)', deltaSeconds: 301, expected: false },
  ];

  it.each(boundaryCases)('$label', ({ deltaSeconds, expected }) => {
    const lastSeenMs = NOW - deltaSeconds * 1000;
    expect(classifyOnline(lastSeenMs, NOW)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// matchesFilter — every filter with a matching and a non-matching device
// ---------------------------------------------------------------------------

const onlineDevice = makeDevice({ deviceId: 'online', lastSeenMs: NOW - 1_000 });
const offlineDevice = makeDevice({ deviceId: 'offline', lastSeenMs: NOW - 400_000 });

interface FilterCase {
  filter: DeviceFilter;
  matching: DeviceAdminRecord;
  /** A representative device the filter excludes; `null` for `all` (matches every device). */
  nonMatching: DeviceAdminRecord | null;
}

const filterCases: FilterCase[] = [
  { filter: 'all', matching: onlineDevice, nonMatching: null },
  { filter: 'online', matching: onlineDevice, nonMatching: offlineDevice },
  { filter: 'offline', matching: offlineDevice, nonMatching: onlineDevice },
  {
    filter: 'web',
    matching: makeDevice({ deviceId: 'web', deviceType: 'web' }),
    nonMatching: makeDevice({ deviceId: 'mobile', deviceType: 'mobile' }),
  },
  {
    filter: 'mobile',
    matching: makeDevice({ deviceId: 'mobile', deviceType: 'mobile' }),
    nonMatching: makeDevice({ deviceId: 'web', deviceType: 'web' }),
  },
  {
    filter: 'tablet',
    matching: makeDevice({ deviceId: 'tablet', deviceType: 'tablet' }),
    nonMatching: makeDevice({ deviceId: 'mobile', deviceType: 'mobile' }),
  },
  {
    filter: 'deleted',
    matching: makeDevice({ deviceId: 'deleted', isDeleted: true }),
    nonMatching: makeDevice({ deviceId: 'active', isDeleted: false }),
  },
  {
    filter: 'logged_out',
    matching: makeDevice({ deviceId: 'manual-logout', logoutType: 'manual' }),
    nonMatching: makeDevice({ deviceId: 'active-session', sessionActive: true }),
  },
  {
    filter: 'force_logged_out',
    matching: makeDevice({ deviceId: 'forced', logoutType: 'forced' }),
    // A manual logout is logged-out but NOT force-logged-out.
    nonMatching: makeDevice({ deviceId: 'manual-logout', logoutType: 'manual' }),
  },
  {
    filter: 'hard_banned',
    matching: makeDevice({ deviceId: 'banned', isHardBanned: true }),
    nonMatching: makeDevice({ deviceId: 'not-banned', isHardBanned: false }),
  },
];

describe('matchesFilter — each filter matches its representative device', () => {
  it.each(filterCases)('filter "$filter" matches its representative device', ({ filter, matching }) => {
    expect(matchesFilter(matching, filter, NOW)).toBe(true);
  });
});

describe('matchesFilter — each narrowing filter excludes a non-matching device', () => {
  const narrowingCases = filterCases.filter((c) => c.nonMatching !== null);

  it.each(narrowingCases)('filter "$filter" excludes a non-matching device', ({ filter, nonMatching }) => {
    expect(matchesFilter(nonMatching as DeviceAdminRecord, filter, NOW)).toBe(false);
  });

  it('filter "all" matches even a device that matches no other filter', () => {
    const plain = makeDevice({ deviceId: 'plain', lastSeenMs: NOW - 400_000 });
    expect(matchesFilter(plain, 'all', NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesSearch — accented characters and whitespace-trimmed terms
// ---------------------------------------------------------------------------

describe('matchesSearch — accented characters and leading/trailing whitespace', () => {
  // Owner display name carries accents; no field contains the ASCII "jose".
  const accentDevice = makeDevice({
    deviceId: 'accented',
    deviceName: 'Téléphone',
    ownerDisplayName: 'José Ñáñez',
  });
  const asciiDevice = makeDevice({
    deviceId: 'ascii',
    deviceName: 'iPhone 14 Pro',
    osName: 'iOS',
    ownerEmail: 'alice@example.com',
  });

  const searchCases: Array<{ label: string; device: DeviceAdminRecord; term: string; expected: boolean }> = [
    {
      label: 'accented term matches an accented field (case-insensitive)',
      device: accentDevice,
      term: 'josé',
      expected: true,
    },
    {
      label: 'accented term matches regardless of case',
      device: accentDevice,
      term: 'JOSÉ',
      expected: true,
    },
    {
      label: 'accented term with surrounding whitespace is trimmed then matched',
      device: accentDevice,
      term: '   José   ',
      expected: true,
    },
    {
      label: 'accents are significant: an ASCII term does not match an accented field',
      device: accentDevice,
      term: 'jose',
      expected: false,
    },
    {
      label: 'leading/trailing whitespace on an ASCII term is trimmed before matching',
      device: asciiDevice,
      term: '   iPhone   ',
      expected: true,
    },
    {
      label: 'ASCII matching is case-insensitive',
      device: asciiDevice,
      term: 'iphone',
      expected: true,
    },
    {
      label: 'a whitespace-only term matches every device',
      device: asciiDevice,
      term: '    ',
      expected: true,
    },
    {
      label: 'a term present in no searchable field does not match',
      device: asciiDevice,
      term: 'no-such-term-xyz',
      expected: false,
    },
  ];

  it.each(searchCases)('$label', ({ device, term, expected }) => {
    expect(matchesSearch(device, term)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// sortAndGroup — distinct "No owner email" final group (Requirement 5.7)
// ---------------------------------------------------------------------------

describe('sortAndGroup — distinct "no owner email" final group', () => {
  const bob = makeDevice({ deviceId: 'b1', deviceName: 'Bob Phone', ownerEmail: 'bob@example.com' });
  const alice = makeDevice({ deviceId: 'a1', deviceName: 'Alice Phone', ownerEmail: 'alice@example.com' });
  const noOwnerUndefined = makeDevice({ deviceId: 'n-undef' }); // ownerEmail omitted
  const noOwnerBlank = makeDevice({ deviceId: 'n-blank', ownerEmail: '   ' }); // whitespace → null
  const noOwnerNull = makeDevice({ deviceId: 'n-null', ownerEmail: null });

  it('orders owner-email groups A→Z and places the no-owner group last', () => {
    const grouped = sortAndGroup(
      [bob, noOwnerUndefined, alice, noOwnerBlank, noOwnerNull],
      'name'
    );

    // Two named groups (alice, bob) plus one no-owner group.
    expect(grouped).toHaveLength(3);
    expect(grouped[0].ownerEmail).toBe('alice@example.com');
    expect(grouped[1].ownerEmail).toBe('bob@example.com');

    // The final group is the distinct no-owner group (Requirement 5.7).
    const finalGroup = grouped[grouped.length - 1];
    expect(finalGroup.ownerEmail).toBeNull();
    expect(finalGroup.devices.map((d) => d.deviceId).sort()).toEqual(
      ['n-blank', 'n-null', 'n-undef']
    );
  });

  it('collects all owner-less devices into a single no-owner group when none have an owner email', () => {
    const grouped = sortAndGroup([noOwnerUndefined, noOwnerBlank, noOwnerNull], 'name');

    expect(grouped).toHaveLength(1);
    expect(grouped[0].ownerEmail).toBeNull();
    expect(grouped[0].devices).toHaveLength(3);
  });

  it('produces no no-owner group when every device has an owner email', () => {
    const grouped = sortAndGroup([bob, alice], 'name');

    expect(grouped).toHaveLength(2);
    expect(grouped.every((g) => g.ownerEmail !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty-filter-result / no-match cases (Requirements 4.4, 5.4)
// ---------------------------------------------------------------------------

describe('empty-result indications', () => {
  const devices = [
    makeDevice({ deviceId: 'd1', deviceName: 'iPhone 14 Pro', osName: 'iOS', ownerEmail: 'alice@example.com' }),
    makeDevice({ deviceId: 'd2', deviceName: 'Pixel 8', osName: 'Android', deviceType: 'mobile' }),
    makeDevice({ deviceId: 'd3', deviceType: 'web', browserName: 'Chrome' }),
  ];

  it('a search term present in no device yields an empty result set (Requirement 4.4)', () => {
    const matched = devices.filter((d) => matchesSearch(d, 'no-such-term-xyz'));
    expect(matched).toEqual([]);
  });

  it('a filter that matches no device yields an empty list (Requirement 5.4)', () => {
    // None of the devices are tablets.
    const matched = devices.filter((d) => matchesFilter(d, 'tablet', NOW));
    expect(matched).toEqual([]);
  });

  it('grouping an empty device list yields no groups', () => {
    expect(sortAndGroup([], 'name')).toEqual([]);
  });
});
