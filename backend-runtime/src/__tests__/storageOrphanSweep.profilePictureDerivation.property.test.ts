// Feature: storage-orphan-cleanup, Property 11: Profile-picture derivation agrees with the upload path
/**
 * Property 11: Profile-picture derivation agrees with the upload path
 *
 * For any email — including uppercase, surrounding and interior whitespace,
 * Unicode, and the whitespace-stripping and lowercasing that
 * `resolveUploadObjectPath` applies — the path the sweep derives for that email
 * equals
 * `resolveUploadObjectPath({ purpose: 'profilePicture', tenantId, email, … }).objectPath`
 * exactly.
 *
 * Asserted by CALLING the writer's own function rather than by comparing two
 * implementations, so the property cannot be satisfied by two copies drifting
 * together. `hashStorageKey` and `sanitizeStorageSegment` are never re-derived
 * here — a sweep that hashed emails its own way would delete exactly the avatars
 * this rule exists to protect, because `profile-pictures/` is the one prefix where
 * reading document fields is NOT the proof (`toggleProfilePictureSource`
 * overwrites `photoURL` with the Google CDN url and clears `customImageURL`, so a
 * live uploaded avatar can have no field pointing at it).
 *
 * Additionally: `isDerivedProfilePictureFilename` accepts exactly
 * `/^[0-9a-f]{20}\.jpg$/`, which is what task 6.2 uses to retain an unexpected
 * `profile-pictures/` filename as `unmanaged_path`.
 *
 * **Validates: Requirements 7.1, 7.2, 7.9**
 *
 * _Requirements: 18.2, 18.3, 18.4_
 */
import * as fc from 'fast-check';

import {
  classifyTenantScopedPath,
  deriveProfilePicturePath,
  isDerivedProfilePictureFilename,
} from '../lib/storageObjectRef';
import { resolveUploadObjectPath } from '../lib/uploadObjectPath';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
const tenantIdArb = fc.constantFrom(
  'acme',
  'acme-2',
  'tenant_1',
  'T-42',
  'x',
  'tenant.co',
  'abcdefghijklmnopqrst0123456789',
);

/** Email fragments: case, whitespace (leading, trailing, interior), Unicode. */
const EMAIL_FRAGMENTS: string[] = [
  'user@example.com',
  'USER@EXAMPLE.COM',
  'User.Name+tag@Example.co.uk',
  '  padded@example.com  ',
  'inner space@example.com',
  'inner\tspace@example.com',
  'inner\nnewline@example.com',
  'multiple   spaces@example.com',
  '\u00a0nbsp@example.com',
  'ünïcodé@example.com',
  '日本語@example.com',
  'user@münchen.de',
  'emoji🎬@example.com',
  'MiXeD CaSe @ Example.COM',
  "quote'd@example.com",
  'plus+only@example.com',
  'a@b.c',
  'x'.repeat(200) + '@example.com',
  // Values that normalise to nothing at all.
  '',
  '   ',
  '\t\n',
  '\u00a0\u2028',
];

const emailArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...EMAIL_FRAGMENTS) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom('', ' ', '  ', '\t'),
        fc.string({ unit: 'grapheme', minLength: 0, maxLength: 20 }),
        fc.constantFrom('@example.com', '@EXAMPLE.com', '', '@münchen.de'),
        fc.constantFrom('', ' ', '\n'),
      )
      .map(([lead, local, domain, trail]) => `${lead}${local}${domain}${trail}`),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 32 }) },
);

/**
 * Arguments the `profilePicture` branch is documented to IGNORE. Generated freely,
 * so the derivation is asserted to be a function of tenant and email alone — which
 * is what makes `deriveProfilePicturePath` pure despite delegating to a resolver
 * that takes a clock and a random suffix.
 */
const ignoredArgsArb = fc.record({
  filename: fc.constantFrom(undefined, 'avatar.png', 'x'),
  contentType: fc.constantFrom(undefined, null, 'image/png', 'application/pdf'),
  uploadKeyHash: fc.constantFrom(null, '0123456789abcdef0123', 'beefbeefbeefbeefbeef'),
  now: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  randomSuffix: fc.constantFrom('', 'aabbcc', 'deadbe'),
});

const HEX_DIGITS = '0123456789abcdef'.split('');

const hexStringArb = (length: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...HEX_DIGITS), { minLength: length, maxLength: length }).map((c) => c.join(''));

describe('Property 11: Profile-picture derivation agrees with the upload path', () => {
  it('derives exactly what resolveUploadObjectPath returns, for any email', () => {
    fc.assert(
      fc.property(tenantIdArb, emailArb, ignoredArgsArb, (tenantId, email, ignored) => {
        const derived = deriveProfilePicturePath({ tenantId, email });

        // The writer's own function, invoked — not a copy of its logic.
        const written = resolveUploadObjectPath({
          purpose: 'profilePicture',
          tenantId,
          email,
          filename: ignored.filename,
          contentType: ignored.contentType,
          uploadKeyHash: ignored.uploadKeyHash,
          now: ignored.now,
          randomSuffix: ignored.randomSuffix,
        });

        if (!written.ok) {
          // The only rejection this branch can produce is a blank email, and the
          // derivation reports it as "there is no such object to retain".
          expect(written.error).toBe('missing_email');
          expect(derived).toBeNull();
          return;
        }

        expect(derived).toBe(written.objectPath);
        expect(written.deterministic).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('derives a path inside the tenant profile-pictures scope whose filename is a derived one', () => {
    fc.assert(
      fc.property(tenantIdArb, emailArb, (tenantId, email) => {
        const derived = deriveProfilePicturePath({ tenantId, email });
        if (derived === null) return;

        expect(classifyTenantScopedPath(derived, tenantId)).toEqual({
          ok: true,
          category: 'profile-pictures',
        });
        expect(derived.startsWith(`profile-pictures/${tenantId}/`)).toBe(true);

        // Every path this rule adds to the retain set is therefore also a path the
        // `unmanaged_path` fallback would NOT divert: the two rules agree on shape.
        const filename = derived.slice(`profile-pictures/${tenantId}/`.length);
        expect(filename).not.toContain('/');
        expect(isDerivedProfilePictureFilename(filename)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('retains the object the writer wrote even when the stored email is padded differently', () => {
    // The writer takes the email from an auth token; the sweep reads it from a
    // `tenantMemberships` or `tenantProfiles` field, where it may carry different
    // whitespace. The writer's normalisation strips ALL whitespace, so the
    // derivation must land on the writer's own path regardless — and the
    // expectation here is the WRITER's output for the unpadded email, never a
    // re-derivation.
    const whitespaceArb = fc.constantFrom('', ' ', '  ', '\t', '\n', '\u00a0');

    fc.assert(
      fc.property(
        tenantIdArb,
        emailArb,
        whitespaceArb,
        fc.integer({ min: 0, max: 64 }),
        (tenantId, email, whitespace, index) => {
          const written = resolveUploadObjectPath({
            purpose: 'profilePicture',
            tenantId,
            email,
            uploadKeyHash: null,
            now: 0,
            randomSuffix: '',
          });
          const expected = written.ok ? written.objectPath : null;

          const surrounded = `${whitespace}${email}${whitespace}`;
          expect(deriveProfilePicturePath({ tenantId, email: surrounded })).toBe(expected);

          const cut = Math.min(index, email.length);
          const interior = `${email.slice(0, cut)}${whitespace}${email.slice(cut)}`;
          expect(deriveProfilePicturePath({ tenantId, email: interior })).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is case-insensitive for an ASCII email, as the writer is', () => {
    // Restricted to ASCII deliberately: `toUpperCase` is not injective over
    // Unicode ('ß' → 'SS'), so an upper-cased non-ASCII email is a DIFFERENT
    // email as far as the writer is concerned, and pretending otherwise would be
    // asserting something the writer does not do.
    const asciiEmailArb = fc
      .tuple(
        // `grapheme-ascii` is already printable ASCII; the filter is belt-and-braces
        // so a future generator change cannot quietly widen this case to Unicode.
        fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 20 }).filter((s) => /^[\x20-\x7e]+$/.test(s)),
        fc.constantFrom('@example.com', '@Example.CO.uk', '@b.c'),
      )
      .map(([local, domain]) => `${local}${domain}`);

    fc.assert(
      fc.property(tenantIdArb, asciiEmailArb, (tenantId, email) => {
        const written = resolveUploadObjectPath({
          purpose: 'profilePicture',
          tenantId,
          email,
          uploadKeyHash: null,
          now: 0,
          randomSuffix: '',
        });
        expect(written.ok).toBe(true);
        if (!written.ok) return;

        expect(deriveProfilePicturePath({ tenantId, email: email.toUpperCase() })).toBe(written.objectPath);
        expect(deriveProfilePicturePath({ tenantId, email: email.toLowerCase() })).toBe(written.objectPath);
      }),
      { numRuns: 200 },
    );
  });
});

describe('Property 11: isDerivedProfilePictureFilename accepts exactly /^[0-9a-f]{20}\\.jpg$/', () => {
  it('accepts every 20-hex-character name with a .jpg extension', () => {
    fc.assert(
      fc.property(hexStringArb(20), (hex) => {
        expect(isDerivedProfilePictureFilename(`${hex}.jpg`)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects every other shape', () => {
    const wrongLengthArb = fc
      .integer({ min: 0, max: 40 })
      .filter((length) => length !== 20)
      .chain((length) => hexStringArb(length));

    const wrongExtensionArb = fc.constantFrom('.png', '.jpeg', '.JPG', '.jpg.png', '', '.jpg ', 'jpg', '.bin');

    const nonHexCharArb = fc.constantFrom('g', 'z', 'A', 'F', '-', '_', '.', '/', ' ', '\u0000', '🎬');

    fc.assert(
      fc.property(
        hexStringArb(20),
        wrongLengthArb,
        wrongExtensionArb,
        nonHexCharArb,
        fc.integer({ min: 0, max: 19 }),
        (hex, wrongLength, wrongExtension, nonHex, index) => {
          // Wrong hex length.
          expect(isDerivedProfilePictureFilename(`${wrongLength}.jpg`)).toBe(false);
          // Wrong extension.
          expect(isDerivedProfilePictureFilename(`${hex}${wrongExtension}`)).toBe(false);
          // A single non-hex character anywhere in the name.
          const mutated = `${hex.slice(0, index)}${nonHex}${hex.slice(index + 1)}`;
          expect(isDerivedProfilePictureFilename(`${mutated}.jpg`)).toBe(false);
          // Padding, path separators and a trailing newline.
          expect(isDerivedProfilePictureFilename(` ${hex}.jpg`)).toBe(false);
          expect(isDerivedProfilePictureFilename(`${hex}.jpg `)).toBe(false);
          expect(isDerivedProfilePictureFilename(`${hex}.jpg\n`)).toBe(false);
          expect(isDerivedProfilePictureFilename(`a/${hex}.jpg`)).toBe(false);
          expect(isDerivedProfilePictureFilename(`profile-pictures/acme/${hex}.jpg`)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
