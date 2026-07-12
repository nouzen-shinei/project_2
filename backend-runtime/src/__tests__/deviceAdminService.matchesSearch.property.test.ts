// Feature: device-console-migration, Property 5: Search membership correctness

/**
 * Property 5: Search membership correctness
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4
 *
 * For any device and any search term, `matchesSearch(device, term)` returns
 * `true` iff at least one of the eight searchable fields — `deviceName`,
 * `deviceType`, `browserName`, `osName`, `modelName`, `ipAddress`,
 * `ownerEmail`, `ownerDisplayName` — contains the term, matched
 * case-insensitively after trimming leading/trailing whitespace from the term.
 * An empty or whitespace-only term matches every device (Requirement 4.1/4.3),
 * and a term present only in a non-searchable field never matches
 * (Requirement 4.2/4.4).
 *
 * This drives the real, exported `matchesSearch` helper from
 * `deviceAdminService.ts` against an independent membership oracle that
 * lowercases/trims the term and checks exactly the same eight fields, so it
 * exercises production behavior rather than a re-interpretation of it.
 */

import * as fc from 'fast-check';

import { matchesSearch, type DeviceAdminRecord } from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------

/**
 * The eight fields the Device Console searches, in the order defined by the
 * requirement. Declared once so the oracle and the field-embedding generators
 * stay in lockstep.
 */
const SEARCHABLE_FIELDS = [
  'deviceName',
  'deviceType',
  'browserName',
  'osName',
  'modelName',
  'ipAddress',
  'ownerEmail',
  'ownerDisplayName',
] as const;

/** A field that is intentionally NOT part of the searchable set (a decoy). */
const NON_SEARCHABLE_FIELDS = [
  'userAgent',
  'osVersion',
  'browserVersion',
  'manufacturer',
  'brand',
  'networkType',
  'carrierName',
  'countryCode',
] as const;

/**
 * Independent re-implementation of the search-membership rule. Kept separate
 * from production code: trims + lowercases the term, treats an empty result as
 * "match all", and otherwise checks whether any searchable field (as a string)
 * contains the normalized term case-insensitively.
 */
function oracleMatchesSearch(device: DeviceAdminRecord, term: string): boolean {
  const normalized = term.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return SEARCHABLE_FIELDS.some((key) => {
    const value = (device as Record<string, unknown>)[key];
    return typeof value === 'string' && value.toLowerCase().includes(normalized);
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A small mixed alphabet (both cases, digits, whitespace, and email/IP-ish
 * punctuation) so generated field values and search terms frequently share
 * substrings — producing a healthy mix of matches and non-matches and
 * naturally exercising case-insensitivity and whitespace trimming.
 */
const CHARS = 'abcABC12 -@.';
const shortString = fc
  .array(fc.constantFrom(...CHARS.split('')), { minLength: 0, maxLength: 8 })
  .map((chars) => chars.join(''));

/** A searchable string field: a string, or missing/null variants. */
const optStrOrNull = fc.oneof(
  shortString,
  fc.constant(undefined),
  fc.constant(null)
);

/** `deviceType` is a small enum in practice; still treated as text by search. */
const deviceTypeArb = fc.option(fc.constantFrom('mobile', 'web', 'tablet'), {
  nil: undefined,
});

/**
 * An arbitrary projected device record carrying every searchable field plus
 * several non-searchable decoy fields. `requiredKeys: []` means any key may be
 * absent, adding undefined-field coverage on top of the explicit null/undefined
 * variants inside the field generators.
 */
const deviceArb: fc.Arbitrary<DeviceAdminRecord> = fc
  .record(
    {
      deviceName: optStrOrNull,
      deviceType: deviceTypeArb,
      browserName: optStrOrNull,
      osName: optStrOrNull,
      modelName: optStrOrNull,
      ipAddress: optStrOrNull,
      ownerEmail: optStrOrNull,
      ownerDisplayName: optStrOrNull,
      // Decoy (non-searchable) fields — must never influence a match.
      userAgent: optStrOrNull,
      osVersion: optStrOrNull,
      browserVersion: optStrOrNull,
      manufacturer: optStrOrNull,
      brand: optStrOrNull,
      networkType: optStrOrNull,
      carrierName: optStrOrNull,
      countryCode: optStrOrNull,
    },
    { requiredKeys: [] }
  )
  .map((partial) => ({ deviceId: 'dev-1', ...partial } as DeviceAdminRecord));

/** Arbitrary search term (may be empty, whitespace, or arbitrary text). */
const termArb = shortString;

/** Whitespace-only (including empty) term generator. */
const whitespaceTermArb = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), {
    minLength: 0,
    maxLength: 6,
  })
  .map((chars) => chars.join(''));

/** A non-empty "core" token (no whitespace) suitable for embedding in a field. */
const coreTokenArb = fc
  .array(fc.constantFrom(...'abcxyz123'.split('')), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(''));

/** Recase each character of a string at random (to exercise case-insensitivity). */
function recasedArb(source: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: source.length, maxLength: source.length })
    .map((flags) =>
      source
        .split('')
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join('')
    );
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Property 5 — search membership correctness', () => {
  it('matches iff the independent field-membership oracle matches (property)', () => {
    fc.assert(
      fc.property(deviceArb, termArb, (device, term) => {
        expect(matchesSearch(device, term)).toBe(oracleMatchesSearch(device, term));
      }),
      { numRuns: 400 }
    );
  });

  it('an empty or whitespace-only term matches every device (property)', () => {
    fc.assert(
      fc.property(deviceArb, whitespaceTermArb, (device, term) => {
        expect(matchesSearch(device, term)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('is case-insensitive: lower/upper/re-cased terms yield the same result (property)', () => {
    fc.assert(
      fc.property(
        deviceArb,
        termArb.chain((term) =>
          recasedArb(term).map((recased) => ({ term, recased }))
        ),
        (device, { term, recased }) => {
          const expected = oracleMatchesSearch(device, term);
          expect(matchesSearch(device, term)).toBe(expected);
          expect(matchesSearch(device, term.toUpperCase())).toBe(expected);
          expect(matchesSearch(device, term.toLowerCase())).toBe(expected);
          expect(matchesSearch(device, recased)).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('a term embedded in ANY searchable field is found, case- and whitespace-insensitively (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SEARCHABLE_FIELDS),
        coreTokenArb,
        shortString, // prefix noise
        shortString, // suffix noise
        (field, core, prefix, suffix) => {
          const device = {
            deviceId: 'dev-embed',
            [field]: `${prefix}${core}${suffix}`,
          } as DeviceAdminRecord;
          // Search with padding + arbitrary case; matching trims + lowercases.
          const term = `   ${core.toUpperCase()}  `;
          expect(matchesSearch(device, term)).toBe(true);
          expect(matchesSearch(device, term)).toBe(oracleMatchesSearch(device, term));
        }
      ),
      { numRuns: 200 }
    );
  });

  it('a term present ONLY in a non-searchable field is never matched (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NON_SEARCHABLE_FIELDS),
        coreTokenArb,
        (field, core) => {
          const device = {
            deviceId: 'dev-decoy',
            [field]: `zzz${core}zzz`,
          } as DeviceAdminRecord;
          // Non-empty term, absent from every searchable field.
          expect(matchesSearch(device, core)).toBe(false);
          expect(matchesSearch(device, core)).toBe(oracleMatchesSearch(device, core));
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Concrete examples (anchor the property with human-readable cases)
// ---------------------------------------------------------------------------

describe('matchesSearch — concrete examples', () => {
  const device: DeviceAdminRecord = {
    deviceId: 'd1',
    deviceName: 'Pixel 7 Pro',
    deviceType: 'mobile',
    browserName: 'Chrome',
    osName: 'Android',
    modelName: 'GP4BC',
    ipAddress: '192.168.1.42',
    ownerEmail: 'Alice@Example.com',
    ownerDisplayName: 'Alice Anderson',
    userAgent: 'SecretUAToken', // non-searchable decoy
  };

  it('empty and whitespace-only terms match all', () => {
    expect(matchesSearch(device, '')).toBe(true);
    expect(matchesSearch(device, '   ')).toBe(true);
    expect(matchesSearch(device, '\t\n')).toBe(true);
  });

  it('matches case-insensitively after trimming', () => {
    expect(matchesSearch(device, '  chrome ')).toBe(true);
    expect(matchesSearch(device, 'ANDROID')).toBe(true);
    expect(matchesSearch(device, 'alice@example.com')).toBe(true);
  });

  it('matches across each searchable field', () => {
    expect(matchesSearch(device, 'pixel')).toBe(true); // deviceName
    expect(matchesSearch(device, 'mobile')).toBe(true); // deviceType
    expect(matchesSearch(device, 'gp4bc')).toBe(true); // modelName
    expect(matchesSearch(device, '192.168')).toBe(true); // ipAddress
    expect(matchesSearch(device, 'anderson')).toBe(true); // ownerDisplayName
  });

  it('does not match terms found only in non-searchable fields or absent entirely', () => {
    expect(matchesSearch(device, 'SecretUAToken')).toBe(false); // userAgent is not searchable
    expect(matchesSearch(device, 'nonexistent-term')).toBe(false);
  });
});
