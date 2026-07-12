// Feature: device-console-migration, Property 3: Tenant isolation for the device listing

/**
 * Property 3: Tenant isolation for the device listing
 * **Validates: Requirements 3.1**
 *
 * For any collection of devices tagged to arbitrary tenants and any
 * Selected_Tenant `T`, the list returned by `filterDevicesForTenant(devices, T)`
 * contains EXACTLY those devices associated with `T` — where "associated" is
 * decided (per `tenantDeviceFilter.matchesTenantDevice`, which the service
 * delegates to) by any of:
 *   - `tenantIds` array membership (trimmed, non-empty entries),
 *   - `activeTenantId` equality (trimmed), or
 *   - an ACTIVE `tenantMemberships` entry for `T` (status is treated as
 *     `'active'` when absent/non-string, else compared case-insensitively).
 * and contains NO device associated only with a different tenant. In addition,
 * `assertTenantScope(device, T)` agrees with that association decision for every
 * device.
 *
 * The test drives the real, exported `filterDevicesForTenant` /
 * `assertTenantScope` helpers from `deviceAdminService.ts` (no mocking, no
 * Firestore) against an independent oracle, across hundreds of generated
 * device collections whose tenant association is set via a mix of `tenantIds`
 * arrays, `activeTenantId`, and `tenantMemberships` (with varying active /
 * inactive statuses) across a small set of non-empty, distinct tenant ids.
 *
 * Per `matchesTenantDevice`, an empty/whitespace-only tenant id would "match
 * all"; that behavior belongs to Requirement 3.5 (show no devices when no
 * tenant is scoped) rather than to this isolation property, so the generators
 * deliberately use only the non-empty, distinct tenant ids `t1` / `t2` / `t3`.
 */

import * as fc from 'fast-check';

import {
  filterDevicesForTenant,
  assertTenantScope,
  type DeviceAdminRecord,
} from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Tenant pool — only non-empty, distinct ids (no empty/whitespace ids, which
// `matchesTenantDevice` treats as "match all"; see file header).
// ---------------------------------------------------------------------------

const TENANTS = ['t1', 't2', 't3'] as const;
const tenantIdArb = fc.constantFrom(...TENANTS);

// ---------------------------------------------------------------------------
// Independent oracle (deliberately re-derived from the documented
// `matchesTenantDevice` semantics, not importing the production predicate, so
// the test cross-checks behavior rather than restating it). `assertTenantScope`
// delegates to `matchesTenantDevice` with `allowUntagged` unset (false), so an
// untagged device is NOT associated with any tenant.
// ---------------------------------------------------------------------------

/** A membership counts as active when status is absent/non-string, or lowercases to 'active'. */
function membershipActiveOracle(status: unknown): boolean {
  const normalized = typeof status === 'string' ? status.toLowerCase() : 'active';
  return normalized === 'active';
}

/** Whether `device` is associated with `tenantId` (mirrors matchesTenantDevice, allowUntagged=false). */
function associatedOracle(device: DeviceAdminRecord, tenantId: string): boolean {
  const target = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!target) {
    // Not exercised (generators use non-empty ids), but mirror the "match all" rule.
    return true;
  }

  const tenantIds = Array.isArray(device.tenantIds)
    ? device.tenantIds
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    : [];
  if (tenantIds.includes(target)) {
    return true;
  }

  const active =
    typeof device.activeTenantId === 'string' ? device.activeTenantId.trim() : '';
  if (active === target) {
    return true;
  }

  if (Array.isArray(device.tenantMemberships)) {
    const hit = device.tenantMemberships.some((entry: any) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      const membershipTenantId =
        typeof entry.tenantId === 'string' ? entry.tenantId.trim() : '';
      if (membershipTenantId !== target) {
        return false;
      }
      return membershipActiveOracle(entry.status);
    });
    if (hit) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Generators — set tenant association via a mix of the three channels.
// ---------------------------------------------------------------------------

/** Membership status: active (any letter case), several non-active values, or absent. */
const statusArb = fc.constantFrom<string | undefined>(
  'active',
  'Active',
  'ACTIVE',
  'inactive',
  'pending',
  'suspended',
  undefined
);

/** One membership entry pointing at a tenant in the pool with a varying status. */
const membershipArb = fc.record({
  tenantId: tenantIdArb,
  status: statusArb,
});

/**
 * A single device whose tenant association is set through a MIX of channels:
 * `tenantIds` (a possibly-empty subset of the pool), `activeTenantId` (one of
 * the pool), and `tenantMemberships` (active/inactive entries). Each channel is
 * independently present or absent (`requiredKeys: []`), so the generated set
 * spans devices associated with T through each channel, devices associated only
 * with a different tenant, and fully untagged devices.
 */
const deviceShapeArb = fc.record(
  {
    tenantIds: fc.uniqueArray(tenantIdArb, { maxLength: TENANTS.length }),
    activeTenantId: tenantIdArb,
    tenantMemberships: fc.array(membershipArb, { maxLength: 4 }),
  },
  { requiredKeys: [] }
);

/** A collection of devices with unique, stable device ids (so objects are distinct). */
const devicesArb = fc
  .array(deviceShapeArb, { maxLength: 10 })
  .map((shapes) =>
    shapes.map((shape, index) => ({ deviceId: `d${index}`, ...shape }))
  ) as fc.Arbitrary<DeviceAdminRecord[]>;

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 3 — tenant isolation for the device listing', () => {
  it(
    'filterDevicesForTenant returns exactly the tenant-associated devices (in order), leaks no other-tenant device, and assertTenantScope agrees per device (property)',
    () => {
      fc.assert(
        fc.property(devicesArb, tenantIdArb, (devices, tenant) => {
          const expected = devices.filter((device) => associatedOracle(device, tenant));
          const actual = filterDevicesForTenant(devices, tenant);

          // Exactly the oracle-associated devices, preserving input order.
          expect(actual).toEqual(expected);

          // Everything returned is genuinely associated with the Selected_Tenant.
          for (const device of actual) {
            expect(associatedOracle(device, tenant)).toBe(true);
          }

          // No device associated only with a different tenant leaks into the result.
          for (const device of devices) {
            if (!associatedOracle(device, tenant)) {
              expect(actual).not.toContain(device);
            }
          }

          // The per-device scope predicate agrees with the oracle for every device.
          for (const device of devices) {
            expect(assertTenantScope(device, tenant)).toBe(associatedOracle(device, tenant));
          }
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  it(
    'an active tenantMembership for T associates the device with T regardless of status letter case (property)',
    () => {
      fc.assert(
        fc.property(
          tenantIdArb,
          fc.constantFrom('active', 'Active', 'ACTIVE', 'aCtIvE'),
          (tenant, activeStatus) => {
            const device = {
              deviceId: 'd',
              tenantMemberships: [{ tenantId: tenant, status: activeStatus }],
            } as DeviceAdminRecord;

            expect(assertTenantScope(device, tenant)).toBe(true);
            expect(filterDevicesForTenant([device], tenant)).toEqual([device]);
          }
        ),
        { numRuns: 100, verbose: false }
      );
    },
    20_000
  );

  it(
    'a tenantMembership for T that is not active does not, by itself, associate the device with T (property)',
    () => {
      fc.assert(
        fc.property(
          tenantIdArb,
          fc.constantFrom('inactive', 'pending', 'suspended', 'INACTIVE', 'Disabled', 'removed'),
          (tenant, inactiveStatus) => {
            // Only channel to T is an inactive membership → out of scope.
            const device = {
              deviceId: 'd',
              tenantMemberships: [{ tenantId: tenant, status: inactiveStatus }],
            } as DeviceAdminRecord;

            expect(assertTenantScope(device, tenant)).toBe(false);
            expect(filterDevicesForTenant([device], tenant)).toEqual([]);
          }
        ),
        { numRuns: 100, verbose: false }
      );
    },
    20_000
  );

  it(
    'a device tagged only to a different tenant (via any channel) is excluded for T (property)',
    () => {
      fc.assert(
        fc.property(
          fc.tuple(tenantIdArb, tenantIdArb).filter(([selected, other]) => selected !== other),
          fc.constantFrom('tenantIds', 'activeTenantId', 'membership'),
          ([selected, other], channel) => {
            const device: DeviceAdminRecord = { deviceId: 'd' };
            if (channel === 'tenantIds') {
              device.tenantIds = [other];
            } else if (channel === 'activeTenantId') {
              device.activeTenantId = other;
            } else {
              device.tenantMemberships = [{ tenantId: other, status: 'active' }];
            }

            // Associated with `other`, never with the disjoint `selected`.
            expect(assertTenantScope(device, other)).toBe(true);
            expect(assertTenantScope(device, selected)).toBe(false);
            expect(filterDevicesForTenant([device], selected)).toEqual([]);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    20_000
  );
});
