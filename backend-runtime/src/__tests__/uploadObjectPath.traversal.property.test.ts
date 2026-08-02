// Feature: upload-idempotency, Property 4: Every resolved path is confined to the caller's tenant prefix
/**
 * Property 4: Every resolved path is confined to the caller's tenant prefix
 *
 * For any purpose and any client-supplied `filename`, `feeId`, `conversationFolder`,
 * `email` or `uploadKey` — including strings containing `../`, `..\`, `/`, NUL and
 * Unicode look-alikes — a successfully resolved `objectPath` starts with
 * `{category}/{tenantId}/` for a category in `STORAGE_TENANT_CATEGORIES`, contains no
 * `..` path segment, no empty segment, and no leading slash.
 *
 * **Validates: Requirements 6.5, 10.6**
 *
 * ---------------------------------------------------------------------------
 * Why the assertions are SEGMENT-level, not substring-level
 * ---------------------------------------------------------------------------
 * `sanitizeStorageSegment` maps every character outside `[A-Za-z0-9._-]` to `_`, so
 * `../../../etc/passwd` becomes `.._.._.._etc_passwd`. That value legitimately
 * CONTAINS the substring `..` while being a single, confined path segment — nothing
 * can traverse out of it. Asserting `!objectPath.includes('..')` would therefore fail
 * on correct code, and "fixing" it by stripping dot runs inside a segment would break
 * Requirement 10.3 (the helpers are relocated *unchanged*) and Requirement 2.1
 * (legacy paths reproduced character-for-character) for ordinary filenames such as
 * `report..v2.pdf`.
 *
 * Confinement is a statement about path *segments*: split on `/` and assert no
 * segment is `..` (nor `.`, nor empty). That is exactly what Requirement 6.5 says.
 */
import * as fc from 'fast-check';

import {
  deriveUploadKeyHash,
  resolveUploadObjectPath,
  type StorageUploadPurpose,
} from '../lib/uploadObjectPath';

// ---------------------------------------------------------------------------
// The six managed prefixes, mirrored from `app.ts:13808` (route-local const).
// ---------------------------------------------------------------------------
const STORAGE_TENANT_CATEGORIES = new Set([
  'chat-files',
  'tenant-branding',
  'notices',
  'student_profiles',
  'receipts',
  'profile-pictures',
]);

const PURPOSES: StorageUploadPurpose[] = [
  'chat',
  'tenantLogo',
  'noticeImage',
  'noticeAudio',
  'studentProfile',
  'receipt',
  'profilePicture',
];

// ---------------------------------------------------------------------------
// Hostile-string generator
// ---------------------------------------------------------------------------
/**
 * Traversal / injection tokens. Composed into longer strings below so a payload can
 * mix encodings (e.g. `..%2f` + `\u0000` + `....//`).
 */
const HOSTILE_TOKENS: string[] = [
  // Plain traversal
  '../',
  '..\\',
  '..',
  '.',
  '...',
  './',
  '/',
  '\\',
  '//',
  '\\\\',
  // Absolute / drive-rooted
  '/etc/passwd',
  '../../../etc/passwd',
  '..\\..\\..\\windows\\system32',
  'C:\\Windows\\system32',
  '/../',
  // NUL and other control bytes
  '\u0000',
  '\u0000../',
  'file\u0000.jpg',
  '\r\n',
  '\n../',
  '\t',
  '\u001b[31m',
  // Percent-encoded traversal
  '%2e%2e%2f',
  '%2E%2E%5C',
  '%252e%252e%252f',
  '..%2f',
  '..%5c',
  '%2f..%2f',
  // Dot-run / filter-bypass shapes
  '....//',
  '....\\\\',
  '..;/',
  '.../',
  '..%00/',
  // Overlong UTF-8 sequences (the raw bytes 0xC0 0xAE = overlong '.',
  // 0xC0 0xAF = overlong '/', 0xE0 0x80 0xAF = 3-byte overlong '/'),
  // as they arrive when a latin-1 decode is applied.
  '\u00c0\u00ae\u00c0\u00ae\u00c0\u00af',
  '\u00e0\u0080\u00ae\u00e0\u0080\u00af',
  '..%c0%af',
  '%c0%ae%c0%ae/',
  // Unicode look-alikes for '.' and '/'
  '\uff0e\uff0e\uff0f', // FULLWIDTH FULL STOP x2 + FULLWIDTH SOLIDUS
  '\u2024\u2024\u2215', // ONE DOT LEADER x2 + DIVISION SLASH
  '\u2044', // FRACTION SLASH
  '\u29f8', // BIG SOLIDUS
  '\uff3c', // FULLWIDTH REVERSE SOLIDUS
  '\u2e2e', // REVERSED QUESTION MARK (noise)
  '\u202e', // RIGHT-TO-LEFT OVERRIDE (extension spoofing)
  '\ufeff', // BOM
  // Whitespace-only and empty
  '',
  ' ',
  '   ',
  // Segment separators that matter to the resolver's own formats
  '_',
  'k_',
  'c_',
  'c_0000000000',
];

/** Very long payloads: length-based bypass attempts. */
const LONG_HOSTILE: string[] = [
  '../'.repeat(400),
  '..\\'.repeat(400),
  '.'.repeat(4096),
  'a'.repeat(8192),
  `${'../'.repeat(200)}etc/passwd`,
  `${'A'.repeat(2000)}\u0000${'../'.repeat(50)}`,
];

const hostileTokenArb = fc.constantFrom(...HOSTILE_TOKENS);

/** A hostile string: composed tokens, tokens spliced with arbitrary text, long payloads, raw Unicode. */
const hostileStringArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .array(hostileTokenArb, { minLength: 1, maxLength: 6 })
      .map((parts) => parts.join('')),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(hostileTokenArb, fc.string({ maxLength: 16 }), hostileTokenArb)
      .map(([a, mid, b]) => `${a}${mid}${b}`),
  },
  { weight: 2, arbitrary: fc.constantFrom(...LONG_HOSTILE) },
  // Raw arbitrary Unicode (surrogates, control chars, astral planes).
  { weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 48 }) },
  { weight: 1, arbitrary: fc.constant('') },
);

/** Client-controlled fields are optional on the resolver, so `undefined` is in the space too. */
const optionalHostileStringArb = fc.option(hostileStringArb, { nil: undefined });

/**
 * `tenantId` is NOT client-controlled: the route takes it from
 * `req.tenantAccess.tenantId` (Requirement 6.6), so the generator produces
 * realistic guard-resolved values rather than hostile ones. The property below
 * asserts the resolved tenant segment always equals this server-supplied value.
 */
const tenantIdArb = fc.constantFrom(
  'acme',
  'tenant_1',
  'T-42',
  'x',
  'abcdefghijklmnopqrst0123456789',
  'tenant.co',
);

const actorUidArb = fc.constantFrom('uid_123', 'staff-9', 'A'.repeat(28), 'u1');

const contentTypeArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('image/png', 'image/jpeg', 'application/pdf', 'audio/mp4', 'video/mp4') },
  { weight: 2, arbitrary: fc.option(hostileStringArb, { nil: null }) },
);

const nowArb = fc.integer({ min: 0, max: 4_000_000_000_000 });
const randomSuffixArb = fc.constantFrom('aabbcc', '000000', 'ff00aa', 'deadbe');

interface HostileCase {
  purpose: StorageUploadPurpose;
  tenantId: string;
  actorUid: string;
  filename?: string;
  feeId?: string;
  conversationFolder?: string;
  email?: string;
  uploadKey?: string;
  contentType?: string | null;
  now: number;
  randomSuffix: string;
}

const hostileCaseArb: fc.Arbitrary<HostileCase> = fc.record({
  purpose: fc.constantFrom(...PURPOSES),
  tenantId: tenantIdArb,
  actorUid: actorUidArb,
  filename: optionalHostileStringArb,
  feeId: optionalHostileStringArb,
  conversationFolder: optionalHostileStringArb,
  email: optionalHostileStringArb,
  uploadKey: optionalHostileStringArb,
  contentType: contentTypeArb,
  now: nowArb,
  randomSuffix: randomSuffixArb,
});

// ---------------------------------------------------------------------------
// Confinement assertion (segment-level, per Requirement 6.5)
// ---------------------------------------------------------------------------
function assertConfined(objectPath: string, tenantId: string): void {
  // No leading slash.
  expect(objectPath.startsWith('/')).toBe(false);

  const segments = objectPath.split('/');

  // `{category}/{tenantId}/…` — at least one segment after the tenant.
  expect(segments.length).toBeGreaterThanOrEqual(3);
  expect(STORAGE_TENANT_CATEGORIES.has(segments[0])).toBe(true);
  // Tenant isolation: the tenant segment is the SERVER-supplied value, always.
  expect(segments[1]).toBe(tenantId);
  expect(objectPath.startsWith(`${segments[0]}/${tenantId}/`)).toBe(true);

  for (const segment of segments) {
    // No empty segment (so no `//`, and no trailing `/`).
    expect(segment).not.toBe('');
    // No relative-path segment. NOTE: segment-level, deliberately not a
    // substring check — see the header comment.
    expect(segment).not.toBe('..');
    expect(segment).not.toBe('.');
  }

  // Nothing outside the sanitizer's character set reached a variable segment:
  // separators and NUL cannot survive `sanitizeStorageSegment`.
  expect(objectPath).not.toContain('\\');
  expect(objectPath).not.toContain('\u0000');
}

/** `{category}/{tenantId}` — the part no client-controlled field may influence. */
function tenantPrefixOf(objectPath: string): string {
  return objectPath.split('/').slice(0, 2).join('/');
}

describe("Property 4: Every resolved path is confined to the caller's tenant prefix", () => {
  it('confines every resolved path when hostile strings are fed into every client-controlled field', () => {
    fc.assert(
      fc.property(hostileCaseArb, (c) => {
        const uploadKeyHash = deriveUploadKeyHash({
          uploadKey: c.uploadKey,
          tenantId: c.tenantId,
          purpose: c.purpose,
          actorUid: c.actorUid,
        });

        const result = resolveUploadObjectPath({
          purpose: c.purpose,
          tenantId: c.tenantId,
          filename: c.filename,
          contentType: c.contentType,
          conversationFolder: c.conversationFolder,
          feeId: c.feeId,
          email: c.email,
          uploadKeyHash,
          now: c.now,
          randomSuffix: c.randomSuffix,
        });

        // A rejected input carries no path, so there is nothing to confine.
        if (!result.ok) {
          expect(['missing_email', 'invalid_upload_purpose']).toContain(result.error);
          return;
        }

        assertConfined(result.objectPath, c.tenantId);

        // Tenant-isolation direction: `{category}/{tenantId}` is identical to what a
        // wholly benign request for the same purpose/tenant resolves to, i.e. no
        // client-controlled field can steer it.
        const benign = resolveUploadObjectPath({
          purpose: c.purpose,
          tenantId: c.tenantId,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          conversationFolder: 'c_0123456789',
          feeId: 'fee_77',
          email: 'user@example.com',
          uploadKeyHash: deriveUploadKeyHash({
            uploadKey: 'benign-upload-key-0001',
            tenantId: c.tenantId,
            purpose: c.purpose,
            actorUid: c.actorUid,
          }),
          now: c.now,
          randomSuffix: c.randomSuffix,
        });
        expect(benign.ok).toBe(true);
        if (benign.ok) {
          expect(tenantPrefixOf(result.objectPath)).toBe(tenantPrefixOf(benign.objectPath));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('confines the path even when a hostile string reaches `uploadKeyHash` directly', () => {
    // `deriveUploadKeyHash` only ever emits `[0-9a-f]{20}`, so this covers the
    // resolver's defense-in-depth sanitization of the hash argument itself.
    fc.assert(
      fc.property(hostileCaseArb, hostileStringArb, (c, rawKeyHash) => {
        const result = resolveUploadObjectPath({
          purpose: c.purpose,
          tenantId: c.tenantId,
          filename: c.filename,
          contentType: c.contentType,
          conversationFolder: c.conversationFolder,
          feeId: c.feeId,
          email: c.email,
          uploadKeyHash: rawKeyHash,
          now: c.now,
          randomSuffix: c.randomSuffix,
        });

        if (!result.ok) {
          expect(['missing_email', 'invalid_upload_purpose']).toContain(result.error);
          return;
        }

        assertConfined(result.objectPath, c.tenantId);
      }),
      { numRuns: 300 },
    );
  });
});
