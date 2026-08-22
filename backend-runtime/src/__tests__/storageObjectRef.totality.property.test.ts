// Feature: storage-orphan-cleanup, Property 3: The URL↔path mapping is total over hostile and malformed input
/**
 * Property 3: The URL↔path mapping is total over hostile and malformed input
 *
 * For any value — every string (empty, whitespace, 10 kB, embedded NUL, lone `%`,
 * `%zz`, overlong UTF-8, `javascript:`, `data:`, protocol-relative `//host/x`, a
 * url whose path contains a literal segment `o`, a url whose object segment
 * contains a literal `%2F`), every non-string (`null`, `undefined`, numbers,
 * arrays, objects, an object whose `toString` throws), every bucket name
 * (including empty and one that is a prefix of the real bucket) and both settings
 * of `allowBarePath` — `resolveBucketObjectPath` RETURNS a well-formed result and
 * never throws.
 *
 * `ok: true` ⇒ `objectPath` is non-empty, ≤ 1024 UTF-8 BYTES, has no leading `/`,
 * and contains no empty, `.` or `..` segment. `ok: false` ⇒ one of the four
 * declared reasons.
 *
 * The byte measure is the GCS limit's own: a name is capped at 1024 bytes, and the
 * parser checked `path.length` (UTF-16 code units), so 1024 astral characters
 * measured 1024 and weighed 4096. The code-unit bound below is KEPT as well — it
 * still holds, since `Buffer.byteLength(s) >= s.length` for every string — and the
 * byte bound is added alongside it, so this invariant tightened rather than moved.
 *
 * **Validates: Requirements 3.3, 3.15, 3.16**
 *
 * ---------------------------------------------------------------------------
 * Why totality is a safety property here, not a stylistic one
 * ---------------------------------------------------------------------------
 * This function runs once per reference field of every record of every tenant. An
 * escaped exception aborts the enumeration, `failedSources` becomes non-empty and
 * the sweep aborts — safe, but it makes the tool useless the first time a single
 * malformed url exists in production data. So the assertion is deliberately over
 * "it returned at all", with the shape invariants as the second half.
 *
 * _Requirements: 18.2, 18.3, 18.4_
 */
import * as fc from 'fast-check';

import {
  resolveBucketObjectPath,
  type ResolveBucketObjectPathResult,
} from '../lib/storageObjectRef';

const REAL_BUCKET = 'tution-app-6c0c3.firebasestorage.app';

const DECLARED_REASONS = ['empty', 'not_a_storage_url', 'foreign_bucket', 'malformed'];

// ---------------------------------------------------------------------------
// Bucket names: the real one, an empty one, a whitespace one, one that is a
// strict PREFIX of the real one (a same-named path in a differently-named bucket
// must never be credited), and hostile shapes.
// ---------------------------------------------------------------------------
const bucketNameArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant(REAL_BUCKET) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      'tution-app-6c0c3',
      'tution-app-6c0c3.firebasestorage', // strict prefix of the real bucket
      'tution-app-6c0c3.firebasestorage.app.evil.com',
      'TUTION-APP-6C0C3.FIREBASESTORAGE.APP',
      'someone-elses-bucket',
    ),
  },
  { weight: 2, arbitrary: fc.constantFrom('', ' ', '   ', '\t') },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 24 }) },
);

// ---------------------------------------------------------------------------
// Hostile string fragments, then whole hostile values.
// ---------------------------------------------------------------------------
const HOSTILE_FRAGMENTS: string[] = [
  '',
  ' ',
  '\t\n',
  '/',
  '//',
  '../',
  '..%2F',
  '%2e%2e%2f',
  '....//',
  '%',
  '%z',
  '%zz',
  '%2',
  '%25',
  '%00',
  '\u0000',
  '\uD800', // lone surrogate
  '\uFEFF',
  '\u00c0\u00ae\u00c0\u00af', // overlong UTF-8 as latin-1
  'o',
  'o/',
  '%2F',
  'notices',
  'acme',
  'chat-files%2Facme%2Fc_9f2a%2Fclip.mov',
  '.',
  '..',
  '?alt=media',
  '&token=abc',
  '#frag',
  ':',
  'gs:',
  'https:',
];

const hostileFragmentArb = fc.constantFrom(...HOSTILE_FRAGMENTS);

/** Scheme/host prefixes, so the generator reaches every branch of the parser. */
const PREFIXES: string[] = [
  '',
  'gs://',
  `gs://${REAL_BUCKET}/`,
  'gs://someone-elses-bucket/',
  'https://',
  'http://',
  '//',
  `https://firebasestorage.googleapis.com/v0/b/${REAL_BUCKET}/o/`,
  'https://firebasestorage.googleapis.com/v0/b/someone-elses-bucket/o/',
  'https://firebasestorage.googleapis.com/',
  `https://${REAL_BUCKET}/`,
  'https://tution-app-6c0c3.firebasestorage.app.firebasestorage.app/',
  `https://storage.googleapis.com/${REAL_BUCKET}/`,
  'https://storage.googleapis.com/',
  `https://${REAL_BUCKET}.storage.googleapis.com/`,
  'https://media.giphy.com/media/',
  'javascript:',
  'data:text/plain;base64,',
  'mailto:',
  'file:///',
  'HTTPS://',
  'GS://',
];

const LONG_VALUES: string[] = [
  'a'.repeat(10_240),
  `https://firebasestorage.googleapis.com/v0/b/${REAL_BUCKET}/o/${'a'.repeat(2048)}`,
  `https://firebasestorage.googleapis.com/v0/b/${REAL_BUCKET}/o/${encodeURIComponent(`notices/acme/${'b'.repeat(1100)}.png`)}`,
  `notices/acme/${'c'.repeat(1007)}.png`, // exactly 1024
  `notices/acme/${'c'.repeat(1008)}.png`, // 1025
  '../'.repeat(400),
];

/** Real spellings, so the space is not entirely garbage. */
const REAL_VALUES: string[] = [
  `https://firebasestorage.googleapis.com/v0/b/${REAL_BUCKET}/o/chat-files%2Facme%2Fc_9f2a%2Fk_3b1c_clip.mov?alt=media&token=abc-123`,
  `https://firebasestorage.googleapis.com/v0/b/${REAL_BUCKET}/o/o%2Fnotices%2Facme%2Fx.png`,
  `https://firebasestorage.googleapis.com/v0/b/${REAL_BUCKET}/o/notices%2Facme%2F50%252F50.png`,
  `gs://${REAL_BUCKET}/notices/acme/audio/notice_audio_k_dead.m4a`,
  'notices/acme/audio/notice_audio_k_dead.m4a',
  'https://media.giphy.com/media/xyz/giphy.gif',
  'https://lh3.googleusercontent.com/a/default-user=s96-c',
];

const hostileStringArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .tuple(fc.constantFrom(...PREFIXES), fc.array(hostileFragmentArb, { minLength: 1, maxLength: 6 }))
      .map(([prefix, parts]) => `${prefix}${parts.join('')}`),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(fc.constantFrom(...PREFIXES), fc.string({ unit: 'binary', maxLength: 32 }), hostileFragmentArb)
      .map(([prefix, middle, tail]) => `${prefix}${middle}${tail}`),
  },
  { weight: 2, arbitrary: fc.constantFrom(...REAL_VALUES) },
  { weight: 2, arbitrary: fc.constantFrom(...LONG_VALUES) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 64 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 48 }) },
);

/**
 * Non-strings, including the two shapes that make an unguarded parser throw
 * before it parses anything: a value whose `toString` throws, and a null-
 * prototype object that cannot be converted to a primitive at all.
 */
const throwingValueArb: fc.Arbitrary<unknown> = fc.constantFrom(
  () => ({
    toString() {
      throw new Error('unreadable toString');
    },
  }),
  () => ({
    get length(): number {
      throw new Error('unreadable getter');
    },
    toString() {
      throw new Error('unreadable toString');
    },
  }),
  () => Object.create(null) as object,
  () => ({
    [Symbol.toPrimitive]() {
      throw new Error('unreadable Symbol.toPrimitive');
    },
  }),
).map((factory) => factory());

const valueArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 6, arbitrary: hostileStringArb },
  { weight: 3, arbitrary: fc.anything() },
  { weight: 2, arbitrary: throwingValueArb },
  {
    weight: 1,
    arbitrary: fc.constantFrom<unknown>(null, undefined, 0, -1, NaN, Infinity, true, false, [], {}),
  },
);

const optionsArb = fc.oneof(
  fc.constant(undefined),
  fc.constant({}),
  fc.constant({ allowBarePath: true }),
  fc.constant({ allowBarePath: false }),
);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
/** Never let the assertion helper itself be the thing that throws. */
function describeSafely(value: unknown): string {
  try {
    return typeof value === 'string' ? JSON.stringify(value.slice(0, 120)) : Object.prototype.toString.call(value);
  } catch {
    return '<undescribable>';
  }
}

function assertWellFormed(result: ResolveBucketObjectPathResult): void {
  expect(typeof result).toBe('object');
  expect(result).not.toBeNull();

  if (result.ok) {
    const { objectPath } = result;
    expect(typeof objectPath).toBe('string');
    expect(objectPath.length).toBeGreaterThan(0);
    expect(objectPath.length).toBeLessThanOrEqual(1024);
    // The GCS limit is a BYTE limit. Strictly stronger than the code-unit bound
    // above, which is retained rather than replaced.
    expect(Buffer.byteLength(objectPath, 'utf8')).toBeLessThanOrEqual(1024);
    expect(objectPath.startsWith('/')).toBe(false);
    expect(objectPath).not.toContain('\u0000');
    for (const segment of objectPath.split('/')) {
      expect(segment).not.toBe('');
      expect(segment).not.toBe('.');
      expect(segment).not.toBe('..');
    }
    return;
  }

  expect(DECLARED_REASONS).toContain(result.reason);
}

describe('Property 3: The URL↔path mapping is total over hostile and malformed input', () => {
  it('always returns a well-formed result, for any value, bucket name and allowBarePath setting', () => {
    fc.assert(
      fc.property(valueArb, bucketNameArb, optionsArb, (value, bucketName, options) => {
        let result: ResolveBucketObjectPathResult;
        try {
          result = resolveBucketObjectPath(value, bucketName, options);
        } catch (err) {
          throw new Error(
            `resolveBucketObjectPath threw for value ${describeSafely(value)} and bucket ${describeSafely(bucketName)}: ${describeSafely(err)}`,
          );
        }
        assertWellFormed(result);
      }),
      { numRuns: 300 },
    );
  });

  it('never proves anything ours when the configured bucket name is blank', () => {
    // With no bucket identity nothing can be PROVEN to be in our bucket, so every
    // value must fail — otherwise a misconfigured run would build a retain set
    // out of foreign references.
    fc.assert(
      fc.property(valueArb, fc.constantFrom('', ' ', '   ', '\t\n'), optionsArb, (value, bucketName, options) => {
        const result = resolveBucketObjectPath(value, bucketName, options);
        expect(result.ok).toBe(false);
        assertWellFormed(result);
      }),
      { numRuns: 200 },
    );
  });

  it('never reinterprets a value as a bare path when allowBarePath is not true', () => {
    // The direction that matters: turning `allowBarePath` off can only ever make
    // a result MORE conservative, so a garbage url can never be re-read as a path
    // that retains an unrelated object.
    fc.assert(
      fc.property(valueArb, bucketNameArb, (value, bucketName) => {
        const permissive = resolveBucketObjectPath(value, bucketName, { allowBarePath: true });
        const strict = resolveBucketObjectPath(value, bucketName, { allowBarePath: false });
        assertWellFormed(permissive);
        assertWellFormed(strict);
        if (strict.ok) {
          // Anything the strict setting accepts was recognised by scheme or host,
          // so the permissive setting must agree on the identical path.
          expect(permissive.ok).toBe(true);
          if (permissive.ok) expect(permissive.objectPath).toBe(strict.objectPath);
        }
      }),
      { numRuns: 200 },
    );
  });
});
