/**
 * Property-based tests for the pure `deriveTenantIndex` Index_Derivation
 * (Stage 1 of the `device-tenant-index` feature).
 *
 * These exercise the four Stage-1 correctness properties from the design
 * document against the real, exported `deriveTenantIndex` (and the authoritative
 * `matchesTenantDevice` predicate it must agree with) — no mocking, no
 * Firestore. Each property runs a minimum of 100 fast-check iterations and is
 * tagged on its first line with the exact design property text.
 *
 * The device generator deliberately produces MALFORMED and adversarial shapes
 * (non-string / whitespace / duplicate `tenantIds`; present / absent / blank /
 * non-string `activeTenantId`; `tenantMemberships` with mixed-case / absent /
 * non-string `status` and blank / non-string `tenantId`) plus arbitrary
 * non-scope fields, so the properties are checked across the full input space
 * the derivation must tolerate.
 */

import * as fc from 'fast-check';

import { deriveTenantIndex } from '../deviceAdminService';
import { matchesTenantDevice } from '../tenantDeviceFilter';

// ---------------------------------------------------------------------------
// Generators — arbitrary, frequently-malformed device shapes.
// ---------------------------------------------------------------------------

/**
 * A small pool of "real" tenant ids the device may be associated with, plus
 * whitespace-padded and blank variants so trimming / empty-exclusion is
 * exercised. Trimmed non-empty values collapse to `t1` / `t2` / `t3`.
 */
const TRIMMED_TENANTS = ['t1', 't2', 't3'] as const;

/** A single `tenantIds` entry: a real id, a padded id, a blank string, or a non-string. */
const tenantIdEntryArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...TRIMMED_TENANTS),
  fc.constantFrom('  t1  ', '\tt2', 't3\n', '  ', '', '\t\n'),
  // Non-string junk that must be ignored by both derivation and predicate.
  fc.constantFrom<unknown>(null, undefined, 0, 42, true, false, {}, ['t1'])
);

/** `activeTenantId`: a real id, padded, blank, absent, or a non-string. */
const activeTenantIdArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...TRIMMED_TENANTS),
  fc.constantFrom('  t1  ', 't2 ', ' t3 ', '', '   '),
  fc.constantFrom<unknown>(null, undefined, 5, true, { tenantId: 't1' })
);

/** Membership `status`: active (mixed case), inactive variants, absent, or non-string. */
const statusArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom('active', 'Active', 'ACTIVE', 'aCtIvE'),
  fc.constantFrom('inactive', 'pending', 'suspended', 'removed', ''),
  fc.constantFrom<unknown>(undefined, null, 1, true, {})
);

/** Membership `tenantId`: a real id, padded, blank, or non-string. */
const membershipTenantIdArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...TRIMMED_TENANTS),
  fc.constantFrom('  t1  ', 't2\t', ' t3 ', '', '  '),
  fc.constantFrom<unknown>(null, undefined, 7, {})
);

/** A single (possibly malformed) `tenantMemberships` entry, or non-object junk. */
const membershipArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.record(
    {
      tenantId: membershipTenantIdArb,
      status: statusArb,
      role: fc.constantFrom<unknown>('member', 'admin', undefined),
    },
    { requiredKeys: [] }
  ),
  // Non-object entries the derivation must skip (mirrors matchesTenantDevice).
  fc.constantFrom<unknown>(null, undefined, 'active', 42, [])
);

/** Non-scope fields that must NOT influence the derived index. */
const nonScopeFieldsArb = fc.record(
  {
    deviceId: fc.string(),
    lastSeen: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    lastSeenMs: fc.integer(),
    isOnline: fc.boolean(),
    sessionActive: fc.boolean(),
    logoutType: fc.constantFrom('manual', 'forced', 'auto', undefined),
    expoPushToken: fc.string(),
    isDeleted: fc.boolean(),
    lastTenantId: fc.oneof(fc.constantFrom(...TRIMMED_TENANTS), fc.constant(null)),
  },
  { requiredKeys: [] }
);

/**
 * An arbitrary device document mixing the three scoping channels (each channel
 * independently present or absent) together with arbitrary non-scope fields.
 */
const deviceArb = fc
  .tuple(
    fc.record(
      {
        tenantIds: fc.oneof(
          fc.array(tenantIdEntryArb, { maxLength: 6 }),
          // Occasionally a non-array to exercise the Array.isArray guard.
          fc.constantFrom<unknown>(undefined, null, 't1', 42)
        ),
        activeTenantId: activeTenantIdArb,
        tenantMemberships: fc.oneof(
          fc.array(membershipArb, { maxLength: 5 }),
          fc.constantFrom<unknown>(undefined, null, 'active', 3)
        ),
      },
      { requiredKeys: [] }
    ),
    nonScopeFieldsArb
  )
  .map(([scope, extra]) => ({ ...extra, ...scope }) as Record<string, unknown>);

/**
 * A candidate tenant id `t` to probe the equivalence with: either one of the
 * real trimmed ids (so hits are common) or a guaranteed miss. Always non-empty
 * after trimming — the equivalence only holds for non-empty trimmed ids, and
 * empty ids never reach the query (handled at the listing boundary).
 */
const probeTenantArb = fc.oneof(
  fc.constantFrom(...TRIMMED_TENANTS),
  fc.constantFrom('t1', 't2', 't3', 'other', 'zzz', 'unused')
);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('deriveTenantIndex — Stage 1 correctness properties', () => {
  // Feature: device-tenant-index, Property 1: Index derivation is equivalent to the tenant-scoping predicate
  it(
    'membership in deriveTenantIndex(device) matches matchesTenantDevice(device, t) for any non-empty trimmed t (property)',
    () => {
      fc.assert(
        fc.property(deviceArb, probeTenantArb, (device, t) => {
          const trimmed = t.trim();
          // Guard: the equivalence is stated for non-empty trimmed ids only.
          expect(trimmed.length).toBeGreaterThan(0);

          const index = deriveTenantIndex(device);
          expect(index.includes(trimmed)).toBe(matchesTenantDevice(device, trimmed));
        }),
        { numRuns: 300, verbose: false }
      );
    },
    30_000
  );

  // Feature: device-tenant-index, Property 2: The index is a well-formed set of trimmed, non-empty tenant ids
  it(
    'deriveTenantIndex returns a duplicate-free array of non-empty, already-trimmed strings (property)',
    () => {
      fc.assert(
        fc.property(deviceArb, (device) => {
          const index = deriveTenantIndex(device);

          // It is an array of strings.
          expect(Array.isArray(index)).toBe(true);
          for (const entry of index) {
            expect(typeof entry).toBe('string');
            // Non-empty and equal to its own trimmed value.
            expect(entry.length).toBeGreaterThan(0);
            expect(entry).toBe(entry.trim());
          }

          // No duplicates (a set).
          expect(new Set(index).size).toBe(index.length);

          // Canonical (sorted) output so equality checks are exact array compares.
          expect(index).toEqual([...index].sort());
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  // Feature: device-tenant-index, Property 3: Derivation is idempotent
  it(
    'storing derive(d) back onto the device and deriving again yields the identical set (property)',
    () => {
      fc.assert(
        fc.property(deviceArb, (device) => {
          const first = deriveTenantIndex(device);

          // Storing the derived index back onto the device (a non-scope field
          // from derivation's perspective) does not change the derivation.
          const withIndex = { ...device, tenantIndex: first };
          const second = deriveTenantIndex(withIndex);
          expect(second).toEqual(first);

          // Deriving twice is stable (referential-transparency of the pure fn).
          expect(deriveTenantIndex(device)).toEqual(first);
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  // Feature: device-tenant-index, Property 4: Derivation depends only on the tenant-scoping source
  it(
    'mutating fields other than tenantIds/activeTenantId/tenantMemberships leaves deriveTenantIndex unchanged (property)',
    () => {
      fc.assert(
        fc.property(deviceArb, nonScopeFieldsArb, (device, patch) => {
          const before = deriveTenantIndex(device);

          // Apply an arbitrary patch over non-scope fields only. Guard that the
          // patch never touches a scoping channel.
          const scopeKeys = ['tenantIds', 'activeTenantId', 'tenantMemberships'];
          const safePatch: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(patch)) {
            if (!scopeKeys.includes(key)) {
              safePatch[key] = value;
            }
          }
          const mutated = { ...device, ...safePatch };
          const after = deriveTenantIndex(mutated);

          expect(after).toEqual(before);
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );
});
