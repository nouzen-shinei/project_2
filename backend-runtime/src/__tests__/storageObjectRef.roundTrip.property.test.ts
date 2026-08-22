// Feature: storage-orphan-cleanup, Property 4: Mapping round-trip fidelity
/**
 * Property 4: Mapping round-trip fidelity
 *
 * For any object path `p` that a listing can produce (generated from the fourteen
 * real path formats `src/lib/uploadObjectPath.ts` owns, plus the transcoder's
 * `_h264.mp4` output, with filename segments drawn from a set including spaces,
 * `+`, `%`, `#`, `?`, `&`, `=`, non-ASCII and emoji) and any download token `t`:
 *
 *   resolveBucketObjectPath(buildFirebaseDownloadUrl(bucket, p, t), bucket)
 *     === { ok: true, objectPath: p }
 *
 * and the result is INDEPENDENT of `t` — the token, the `alt=media` parameter and
 * any additional query parameters do not affect the resolved path. Also
 * idempotent: `resolveBucketObjectPath(p, bucket, { allowBarePath: true })`
 * returns `p`.
 *
 * **Validates: Requirements 3.12, 3.13, 3.14**
 *
 * ---------------------------------------------------------------------------
 * Why this is the highest-value property in the mapper
 * ---------------------------------------------------------------------------
 * The comparison that decides whether an object is an orphan is
 * `retainPaths.has(file.name)`. A mapper that decodes once on one side and twice
 * on the other produces a retain set that does not compare equal to the listing,
 * and EVERY affected object then looks unreferenced. Round-tripping is the only
 * way to assert the two sides agree without asserting one implementation against
 * a copy of itself — which is also why the encoded url here comes from the
 * module's own `buildFirebaseDownloadUrl` (the writer's spelling, mirroring
 * `videoTranscoder.buildDownloadUrl`) rather than from a hand-rolled encoder.
 *
 * _Requirements: 18.2, 18.3, 18.4_
 */
import * as fc from 'fast-check';

import { buildFirebaseDownloadUrl, resolveBucketObjectPath } from '../lib/storageObjectRef';

const BUCKET = 'tution-app-6c0c3.firebasestorage.app';

// ---------------------------------------------------------------------------
// Path-component generators
// ---------------------------------------------------------------------------
const tenantIdArb = fc.constantFrom('acme', 'acme-2', 'tenant_1', 'T-42', 'x', 'tenant.co');

const conversationFolderArb = fc.constantFrom(
  'c_9f2a1b3c4d5e6f708192',
  'c_0000000000',
  'unassigned',
  'c_deadbeefdeadbeefdead',
);

const feeIdArb = fc.constantFrom('fee_77', 'unknown', 'fee-2024_03', 'F.12');

const timestampArb = fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 });
const keyHashArb = fc.constantFrom(
  '3b1c9d0e5f7a2b4c6d8e',
  '0123456789abcdef0123',
  'beefbeefbeefbeefbeef',
  'fedcba98765432100fed',
);
const randomSuffixArb = fc.constantFrom('aabbcc', '000000', 'ff00aa', 'deadbe');
const extArb = fc.constantFrom('jpg', 'png', 'webp', 'pdf', 'm4a', 'mp3', 'mov', 'mp4', 'bin');

/**
 * Filename fragments a LISTING can hold. Deliberately wider than
 * `sanitizeStorageSegment` would emit today: the bucket also holds objects written
 * before that sanitizer existed, and the mapper must survive every one of them.
 * Every fragment is free of `/` and NUL, and is spliced between a fixed prefix and
 * an extension so no generated path can begin or end with whitespace (which the
 * mapper trims off a stored reference by design).
 */
const FILENAME_FRAGMENTS: string[] = [
  'report',
  'with space',
  'two  spaces',
  'a+b',
  '100%',
  '50%2F50',
  'hash#1',
  'query?x',
  'amp&and',
  'eq=sign',
  'plus+and space',
  "apostrophe's",
  'semi;colon',
  'at@sign',
  'tilde~and*star',
  'paren(1)',
  'bracket[2]',
  'comma,list',
  'colon:name',
  'ünïcodé',
  '日本語のファイル',
  'русский',
  'عربي',
  '🎬🎥 clip',
  'e\u0301accent',
  'mixed a b+c%d#e?f&g=h',
  'dots..inside',
  'trailing.dots..',
  '-leading-dash',
  '_leading_underscore',
];

const filenameArb = fc
  .tuple(fc.constantFrom(...FILENAME_FRAGMENTS), extArb)
  .map(([fragment, ext]) => `${fragment}.${ext}`);

// ---------------------------------------------------------------------------
// The fourteen real formats (seven legacy, seven deterministic) plus the
// transcoder's output. `design.md`'s "Object path formats seen in the listing".
// ---------------------------------------------------------------------------
interface PathParts {
  tenantId: string;
  conversationFolder: string;
  feeId: string;
  timestamp: number;
  keyHash: string;
  randomSuffix: string;
  ext: string;
  filename: string;
}

const PATH_FORMATS: readonly { label: string; build: (p: PathParts) => string }[] = [
  {
    label: 'chat (legacy)',
    build: (p) => `chat-files/${p.tenantId}/${p.conversationFolder}/${p.timestamp}_${p.filename}`,
  },
  {
    label: 'chat (deterministic)',
    build: (p) => `chat-files/${p.tenantId}/${p.conversationFolder}/k_${p.keyHash}_${p.filename}`,
  },
  { label: 'tenantLogo (legacy)', build: (p) => `tenant-branding/${p.tenantId}/logo_${p.timestamp}.${p.ext}` },
  {
    label: 'tenantLogo (deterministic)',
    build: (p) => `tenant-branding/${p.tenantId}/logo_k_${p.keyHash}.${p.ext}`,
  },
  {
    label: 'noticeImage (legacy)',
    build: (p) => `notices/${p.tenantId}/notice_${p.timestamp}_${p.randomSuffix}.${p.ext}`,
  },
  {
    label: 'noticeImage (deterministic)',
    build: (p) => `notices/${p.tenantId}/notice_k_${p.keyHash}.${p.ext}`,
  },
  {
    label: 'noticeAudio (legacy)',
    build: (p) => `notices/${p.tenantId}/audio/notice_audio_${p.timestamp}_${p.randomSuffix}.${p.ext}`,
  },
  {
    label: 'noticeAudio (deterministic)',
    build: (p) => `notices/${p.tenantId}/audio/notice_audio_k_${p.keyHash}.${p.ext}`,
  },
  {
    label: 'studentProfile (legacy)',
    build: (p) => `student_profiles/${p.tenantId}/${p.timestamp}_profile.${p.ext}`,
  },
  {
    label: 'studentProfile (deterministic)',
    build: (p) => `student_profiles/${p.tenantId}/k_${p.keyHash}_profile.${p.ext}`,
  },
  {
    label: 'receipt (legacy)',
    build: (p) => `receipts/${p.tenantId}/${p.feeId}/${p.timestamp}_${p.filename}`,
  },
  {
    label: 'receipt (deterministic)',
    build: (p) => `receipts/${p.tenantId}/${p.feeId}/k_${p.keyHash}_${p.filename}`,
  },
  {
    label: 'profilePicture (always deterministic)',
    build: (p) => `profile-pictures/${p.tenantId}/${p.keyHash}.jpg`,
  },
  {
    // The seventh legacy/deterministic pair collapses for profile pictures, so
    // the fourteenth format is the same shape reached through the other branch.
    label: 'profilePicture (via upload key, identical shape)',
    build: (p) => `profile-pictures/${p.tenantId}/${p.keyHash}.jpg`,
  },
  {
    label: 'transcode output',
    build: (p) => `chat-files/${p.tenantId}/${p.conversationFolder}/k_${p.keyHash}_${p.filename}_h264.mp4`,
  },
];

const pathPartsArb: fc.Arbitrary<PathParts> = fc.record({
  tenantId: tenantIdArb,
  conversationFolder: conversationFolderArb,
  feeId: feeIdArb,
  timestamp: timestampArb,
  keyHash: keyHashArb,
  randomSuffix: randomSuffixArb,
  ext: extArb,
  filename: filenameArb,
});

const objectPathArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...PATH_FORMATS.map((format) => format.build)), pathPartsArb)
  .map(([build, parts]) => build(parts));

// ---------------------------------------------------------------------------
// Tokens. Generated freely: a download token is opaque to us, may be absent, may
// be rotated, and must never influence the resolved identity of an object.
// ---------------------------------------------------------------------------
const tokenArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'abc-123',
      '9f1d2b3a-4c5e-6f70-8192-a3b4c5d6e7f8',
      '00000000-0000-0000-0000-000000000000',
      'deadbeef',
    ),
  },
  { weight: 2, arbitrary: fc.constantFrom('', 'a&b=c', 'has#fragment', 'has%25percent', 'has space') },
  { weight: 2, arbitrary: fc.uuid() },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 2_147_483_647 }).map((n) => n.toString(16)) },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme-ascii', maxLength: 24 }) },
);

/** Query suffixes a stored download url is seen with. */
const queryVariantsFor = (token: string): string[] => [
  '',
  '?alt=media',
  `?token=${token}`,
  `?alt=media&token=${token}`,
  `?alt=media&token=${token}&generation=1700000000000000`,
  `?alt=media&token=${token}&x-goog-meta-note=a%2Fb%20c`,
];

const encodedBase = (objectPath: string): string =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(objectPath)}`;

describe('Property 4: Mapping round-trip fidelity', () => {
  it('resolves a download url built for path p back to exactly p', () => {
    fc.assert(
      fc.property(objectPathArb, tokenArb, (objectPath, token) => {
        const url = buildFirebaseDownloadUrl(BUCKET, objectPath, token);
        expect(resolveBucketObjectPath(url, BUCKET)).toEqual({ ok: true, objectPath });
      }),
      { numRuns: 300 },
    );
  });

  it('resolves the identical path irrespective of the token, alt=media and extra query parameters', () => {
    // This is the assertion that a rotated, absent or duplicated token cannot
    // hide a reference: identity is the object segment alone.
    fc.assert(
      fc.property(objectPathArb, tokenArb, tokenArb, (objectPath, tokenA, tokenB) => {
        const base = encodedBase(objectPath);
        const variants = [
          ...queryVariantsFor(tokenA),
          ...queryVariantsFor(tokenB),
          `?token=${tokenA}&token=${tokenB}`,
        ].map((query) => `${base}${query}`);

        for (const url of variants) {
          expect(resolveBucketObjectPath(url, BUCKET)).toEqual({ ok: true, objectPath });
        }

        // And the module's own builder agrees with the hand-assembled base for
        // both tokens, so the two sides of the round trip cannot drift apart.
        expect(resolveBucketObjectPath(buildFirebaseDownloadUrl(BUCKET, objectPath, tokenA), BUCKET)).toEqual(
          resolveBucketObjectPath(buildFirebaseDownloadUrl(BUCKET, objectPath, tokenB), BUCKET),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('is idempotent on a bare path it has previously returned', () => {
    // The other half of the single- vs double-decode guarantee: a raw-path field
    // holding the `file.name` spelling must resolve to itself untouched, so a
    // literal `%` or `%2F` in an object name survives.
    fc.assert(
      fc.property(objectPathArb, tokenArb, (objectPath, token) => {
        expect(resolveBucketObjectPath(objectPath, BUCKET, { allowBarePath: true })).toEqual({
          ok: true,
          objectPath,
        });

        const resolved = resolveBucketObjectPath(buildFirebaseDownloadUrl(BUCKET, objectPath, token), BUCKET);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(
          resolveBucketObjectPath(resolved.objectPath, BUCKET, { allowBarePath: true }),
        ).toEqual({ ok: true, objectPath });
      }),
      { numRuns: 200 },
    );
  });
});
