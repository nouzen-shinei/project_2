/**
 * Feature: storage-orphan-cleanup — task 1.3 golden example tests.
 *
 * THIS FILE IS THE REGRESSION NET FOR THE REFERENCE ENUMERATION ITSELF, which is
 * why the task marks it non-optional. `design.md`'s enumeration table lists every
 * record field that can prove an object is referenced; one golden
 * reference → path case per field lives below. If a change to
 * `resolveBucketObjectPath` breaks one of them, the sweep stops recognising that
 * field's stored spelling — and an unrecognised reference is a deletion, not a
 * mismatch.
 *
 * Every URL literal below is written out by hand in the spelling the referencing
 * code stores (a whole `%2F`-separated encoded object segment for a Firebase
 * download url, a raw `/`-separated path for `audioStoragePath` /
 * `originalPath`), NOT produced by reading `buildFirebaseDownloadUrl` back. The
 * two sides of the round trip are asserted against each other in
 * `storageObjectRef.roundTrip.property.test.ts`; here the expectation is the
 * stored data's shape.
 *
 * Pure jest: no Express app, no Firebase Admin, no bucket, no network — the same
 * posture as `uploadObjectPath.test.ts`.
 *
 * _Requirements: 18.5, 18.6, 18.7_
 */
import {
  QUARANTINE_PREFIX,
  STORAGE_TENANT_CATEGORIES,
  TenantScopeViolation,
  assertTenantScoped,
  buildFirebaseDownloadUrl,
  buildQuarantinePath,
  classifyTenantScopedPath,
  deriveProfilePicturePath,
  isDerivedProfilePictureFilename,
  parseQuarantinePath,
  resolveBucketObjectPath,
} from '../lib/storageObjectRef';

// ---------------------------------------------------------------------------
// Buckets.
//
// `BUCKET` is the real application bucket, whose name already ends in
// `.firebasestorage.app`, so it exercises the `host === bucketName` form.
// `SHORT_BUCKET` is the bare project-id spelling, which is what makes the
// `{bucket}.firebasestorage.app` host form read naturally. Both host forms are
// accepted for whichever bucket name is configured, and both are covered below.
// ---------------------------------------------------------------------------
const BUCKET = 'tution-app-6c0c3.firebasestorage.app';
const SHORT_BUCKET = 'tution-app-6c0c3';
const FOREIGN_BUCKET = 'someone-elses-bucket';
const TENANT = 'acme';

/** A Firebase download url, assembled exactly as a stored reference looks. */
function downloadUrl(bucketName: string, encodedObject: string, query = '?alt=media&token=abc-123'): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedObject}${query}`;
}

// ---------------------------------------------------------------------------
// One golden case per field in `design.md`'s reference-enumeration table.
// ---------------------------------------------------------------------------
interface EnumerationCase {
  /** The record field this spelling comes from. */
  field: string;
  value: string;
  /** `true` for the raw-path fields, exactly as the collector will call it. */
  allowBarePath?: boolean;
  expected: string;
}

const ENUMERATION_CASES: EnumerationCase[] = [
  {
    field: 'RTDB chat message .fileUrl (legacy single-file shape)',
    value: downloadUrl(BUCKET, 'chat-files%2Facme%2Fc_9f2a%2F1700000000000_voice-note.m4a'),
    expected: 'chat-files/acme/c_9f2a/1700000000000_voice-note.m4a',
  },
  {
    field: 'RTDB chat message .attachments[i].url (multi-file shape)',
    value: downloadUrl(
      BUCKET,
      'chat-files%2Facme%2Fc_9f2a%2Fk_3b1c9d0e5f7a2b4c6d8e_holiday%20photo.jpg'
    ),
    expected: 'chat-files/acme/c_9f2a/k_3b1c9d0e5f7a2b4c6d8e_holiday photo.jpg',
  },
  {
    field: 'RTDB chat message .attachments[i].transcodedUrl (transcoder write-back)',
    value: downloadUrl(
      BUCKET,
      'chat-files%2Facme%2Fc_9f2a%2Fk_3b1c9d0e5f7a2b4c6d8e_clip_h264.mp4',
      '?alt=media&token=9f1d2b3a-4c5e-6f70-8192-a3b4c5d6e7f8'
    ),
    expected: 'chat-files/acme/c_9f2a/k_3b1c9d0e5f7a2b4c6d8e_clip_h264.mp4',
  },
  {
    field: 'sharedFiles/{token} .file.url',
    value: downloadUrl(BUCKET, 'chat-files%2Facme%2Fc_9f2a%2F1700000000001_syllabus.pdf'),
    expected: 'chat-files/acme/c_9f2a/1700000000001_syllabus.pdf',
  },
  {
    field: 'fees/{feeId} .receipts[i].url',
    value: downloadUrl(BUCKET, 'receipts%2Facme%2Ffee_77%2Fk_beefbeefbeefbeefbeef_march.pdf'),
    expected: 'receipts/acme/fee_77/k_beefbeefbeefbeefbeef_march.pdf',
  },
  {
    field: 'notices/{id} .imageUrl',
    value: downloadUrl(BUCKET, 'notices%2Facme%2Fnotice_k_dead0dead0dead0dead0.png'),
    expected: 'notices/acme/notice_k_dead0dead0dead0dead0.png',
  },
  {
    // A raw-path field: no scheme, no host, and NOT decoded again.
    field: 'notices/{id} .audioStoragePath (raw path)',
    value: 'notices/acme/audio/notice_audio_k_dead0dead0dead0dead0.m4a',
    allowBarePath: true,
    expected: 'notices/acme/audio/notice_audio_k_dead0dead0dead0dead0.m4a',
  },
  {
    field: 'students/{id} .profileImageUrl',
    value: downloadUrl(BUCKET, 'student_profiles%2Facme%2F1700000000002_profile.jpg'),
    expected: 'student_profiles/acme/1700000000002_profile.jpg',
  },
  {
    field: 'tenants/{id} .logoUrl',
    value: downloadUrl(BUCKET, 'tenant-branding%2Facme%2Flogo_k_0123456789abcdef0123.png'),
    expected: 'tenant-branding/acme/logo_k_0123456789abcdef0123.png',
  },
  {
    field: 'tenants/{id} .branding.accentImageUrl',
    value: downloadUrl(BUCKET, 'tenant-branding%2Facme%2Flogo_k_fedcba98765432100fed.webp'),
    expected: 'tenant-branding/acme/logo_k_fedcba98765432100fed.webp',
  },
  {
    field: 'videoTranscodes/{id} .originalPath (raw path)',
    value: 'chat-files/acme/c_9f2a/k_3b1c9d0e5f7a2b4c6d8e_clip.mov',
    allowBarePath: true,
    expected: 'chat-files/acme/c_9f2a/k_3b1c9d0e5f7a2b4c6d8e_clip.mov',
  },
  {
    field: 'videoTranscodes/{id} .transcodedUrl',
    value: downloadUrl(BUCKET, 'chat-files%2Facme%2Fc_9f2a%2Fk_3b1c9d0e5f7a2b4c6d8e_clip_h264.mp4'),
    expected: 'chat-files/acme/c_9f2a/k_3b1c9d0e5f7a2b4c6d8e_clip_h264.mp4',
  },
];

describe('resolveBucketObjectPath: one golden case per enumerated reference field', () => {
  it.each(ENUMERATION_CASES)('resolves $field', ({ value, allowBarePath, expected }) => {
    expect(resolveBucketObjectPath(value, BUCKET, { allowBarePath })).toEqual({
      ok: true,
      objectPath: expected,
    });
  });

  // The retain set is only ever populated through the scope guard, so a field
  // whose golden spelling resolves but fails the guard would be silently dropped
  // by the collector — a reference that proves nothing.
  it.each(ENUMERATION_CASES)('admits $field to the tenant scope', ({ value, allowBarePath }) => {
    const resolved = resolveBucketObjectPath(value, BUCKET, { allowBarePath });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(classifyTenantScopedPath(resolved.objectPath, TENANT).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The six accepted url/uri forms.
// ---------------------------------------------------------------------------
const OBJECT_PATH = 'notices/acme/notice_k_dead0dead0dead0dead0.png';
const ENCODED_OBJECT = 'notices%2Facme%2Fnotice_k_dead0dead0dead0dead0.png';

/** Query suffixes: absent, `alt=media` only, token, and extra parameters. */
const QUERY_VARIANTS = [
  '',
  '?alt=media',
  '?alt=media&token=abc-123',
  '?token=abc-123',
  '?alt=media&token=abc-123&generation=1700000000000000&x-goog-meta-foo=bar%2Fbaz',
];

interface FormCase {
  form: string;
  bucketName: string;
  /** Built per query variant, because the query is what varies. */
  build: (query: string) => string;
  /** The same shape naming a bucket that is not ours. */
  foreign: string;
}

const FORM_CASES: FormCase[] = [
  {
    form: 'Firebase download url',
    bucketName: BUCKET,
    build: (query) => `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${ENCODED_OBJECT}${query}`,
    foreign: `https://firebasestorage.googleapis.com/v0/b/${FOREIGN_BUCKET}/o/${ENCODED_OBJECT}?alt=media&token=abc-123`,
  },
  {
    form: 'https://{bucket}/{encodedObject}',
    bucketName: BUCKET,
    build: (query) => `https://${BUCKET}/${ENCODED_OBJECT}${query}`,
    foreign: `https://${FOREIGN_BUCKET}/${ENCODED_OBJECT}?alt=media&token=abc-123`,
  },
  {
    form: 'https://{bucket}.firebasestorage.app/{encodedObject}',
    bucketName: SHORT_BUCKET,
    build: (query) => `https://${SHORT_BUCKET}.firebasestorage.app/${ENCODED_OBJECT}${query}`,
    foreign: `https://${FOREIGN_BUCKET}.firebasestorage.app/${ENCODED_OBJECT}?alt=media&token=abc-123`,
  },
  {
    form: 'https://storage.googleapis.com/{bucket}/{path}',
    bucketName: BUCKET,
    build: (query) => `https://storage.googleapis.com/${BUCKET}/${OBJECT_PATH}${query}`,
    foreign: `https://storage.googleapis.com/${FOREIGN_BUCKET}/${OBJECT_PATH}`,
  },
  {
    form: 'https://{bucket}.storage.googleapis.com/{path}',
    bucketName: BUCKET,
    build: (query) => `https://${BUCKET}.storage.googleapis.com/${OBJECT_PATH}${query}`,
    foreign: `https://${FOREIGN_BUCKET}.storage.googleapis.com/${OBJECT_PATH}`,
  },
  {
    form: 'gs://{bucket}/{path}',
    bucketName: BUCKET,
    // A `gs://` uri has no query component: everything after the bucket is the
    // object name, so a query suffix would name a DIFFERENT object rather than
    // being ignored. The query variants therefore do not apply to this form.
    build: () => `gs://${BUCKET}/${OBJECT_PATH}`,
    foreign: `gs://${FOREIGN_BUCKET}/receipts/acme/k_beefbeefbeefbeefbeef_march.pdf`,
  },
];

describe('resolveBucketObjectPath: the six accepted url/uri forms', () => {
  it.each(FORM_CASES)('accepts $form, with and without a token and extra query parameters', ({
    bucketName,
    build,
  }) => {
    for (const query of QUERY_VARIANTS) {
      expect(resolveBucketObjectPath(build(query), bucketName)).toEqual({
        ok: true,
        objectPath: OBJECT_PATH,
      });
    }
  });

  it.each(FORM_CASES)('rejects $form when it names a foreign bucket', ({ bucketName, foreign }) => {
    expect(resolveBucketObjectPath(foreign, bucketName)).toEqual({
      ok: false,
      reason: 'foreign_bucket',
    });
  });

  it.each(FORM_CASES)('rejects $form when the configured bucket name is empty', ({ build }) => {
    // With no bucket identity nothing can be PROVEN to be ours, so an empty (or
    // whitespace-only) bucket name fails every value — the same guard
    // `isOwnBucketStorageUrl` applies.
    expect(resolveBucketObjectPath(build('?alt=media&token=abc-123'), '')).toEqual({
      ok: false,
      reason: 'foreign_bucket',
    });
    expect(resolveBucketObjectPath(build('?alt=media&token=abc-123'), '   ')).toEqual({
      ok: false,
      reason: 'foreign_bucket',
    });
  });

  it('rejects a bare path too when the configured bucket name is empty', () => {
    expect(resolveBucketObjectPath(OBJECT_PATH, '', { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'foreign_bucket',
    });
  });

  it('rejects an unrelated https host as a foreign bucket', () => {
    // A Giphy sticker or a Google avatar: ordinary, ignored without ceremony.
    expect(resolveBucketObjectPath('https://media.giphy.com/media/xyz/giphy.gif', BUCKET)).toEqual({
      ok: false,
      reason: 'foreign_bucket',
    });
  });

  it('treats the Firebase api host with no /v0/b/{bucket}/o/{object} shape as malformed', () => {
    // It names no object, and we cannot tell what it refers to — so the caller
    // must not silently ignore it.
    expect(resolveBucketObjectPath('https://firebasestorage.googleapis.com/v0/b/x', BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

// ---------------------------------------------------------------------------
// `allowBarePath`, both settings, on the same input.
// ---------------------------------------------------------------------------
describe('resolveBucketObjectPath: allowBarePath', () => {
  const BARE = 'notices/acme/audio/notice_audio_k_dead0dead0dead0dead0.m4a';

  it('accepts a bare path when allowBarePath is true', () => {
    expect(resolveBucketObjectPath(BARE, BUCKET, { allowBarePath: true })).toEqual({
      ok: true,
      objectPath: BARE,
    });
  });

  it('refuses the identical value when allowBarePath is absent or false', () => {
    // A broken url must never be reinterpreted as a path that then retains an
    // unrelated object.
    expect(resolveBucketObjectPath(BARE, BUCKET)).toEqual({
      ok: false,
      reason: 'not_a_storage_url',
    });
    expect(resolveBucketObjectPath(BARE, BUCKET, { allowBarePath: false })).toEqual({
      ok: false,
      reason: 'not_a_storage_url',
    });
  });

  it('refuses a value carrying an unrecognised scheme even when allowBarePath is true', () => {
    for (const value of ['javascript:alert(1)', 'data:text/plain;base64,AA==', 'mailto:a@b.com']) {
      expect(resolveBucketObjectPath(value, BUCKET, { allowBarePath: true })).toEqual({
        ok: false,
        reason: 'not_a_storage_url',
      });
    }
  });

  it('refuses a protocol-relative reference even when allowBarePath is true', () => {
    expect(resolveBucketObjectPath('//evil.example.com/notices/acme/x.png', BUCKET, {
      allowBarePath: true,
    })).toEqual({ ok: false, reason: 'not_a_storage_url' });
  });
});

// ---------------------------------------------------------------------------
// Traversal, malformed and hostile inputs.
// ---------------------------------------------------------------------------
describe('resolveBucketObjectPath: traversal and malformed inputs', () => {
  it('rejects percent-encoded traversal in the object segment', () => {
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, '..%2F..%2Fetc%2Fpasswd'), BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, 'notices%2Facme%2F..%2Fx.png'), BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a `.` segment', () => {
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, 'notices%2Facme%2F.%2Fx.png'), BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('turns a decodeURIComponent failure into malformed rather than an exception', () => {
    for (const encoded of ['%zz', '%', 'notices%2Facme%2F%e0%a4%a.png', '%C0%AE%C0%AE%2F']) {
      expect(resolveBucketObjectPath(downloadUrl(BUCKET, encoded), BUCKET)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects a NUL character in the decoded path', () => {
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, 'notices%2Facme%2Fa%00b.png'), BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(resolveBucketObjectPath('notices/acme/a\u0000b.png', BUCKET, { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('strips a single leading slash rather than rejecting it', () => {
    // `design.md`'s normalisation order is explicit: strip a leading `/`, THEN
    // reject empty / `.` / `..` segments. So a leading slash resolves to the
    // object it names — the retention-safe direction — and the `ok: true`
    // postcondition "no leading `/`" still holds. (Requirement 3.8 lists a
    // leading `/` among the malformed causes; the design and task 1.1 are
    // narrower and are what the module implements. Noted here so a reader does
    // not "fix" one to match the other.)
    expect(resolveBucketObjectPath(`/${OBJECT_PATH}`, BUCKET, { allowBarePath: true })).toEqual({
      ok: true,
      objectPath: OBJECT_PATH,
    });
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, `%2F${ENCODED_OBJECT}`), BUCKET)).toEqual({
      ok: true,
      objectPath: OBJECT_PATH,
    });
  });

  it('rejects an empty segment, including a doubled leading slash', () => {
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, 'notices%2F%2Facme%2Fx.png'), BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(resolveBucketObjectPath('notices/acme//x.png', BUCKET, { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    // Only ONE leading slash is stripped, so `//a` fails on its empty first
    // segment rather than being quietly flattened to `a`.
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, '%2F%2Fnotices%2Facme%2Fx.png'), BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a path longer than the 1024-BYTE GCS limit and accepts one exactly at it', () => {
    // ASCII, so bytes and UTF-16 code units coincide — these three cases read the
    // same under either measure and are unchanged.
    const atLimit = `notices/acme/${'a'.repeat(1007)}.png`;
    expect(atLimit).toHaveLength(1024);
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(1024);
    expect(resolveBucketObjectPath(atLimit, BUCKET, { allowBarePath: true })).toEqual({
      ok: true,
      objectPath: atLimit,
    });

    const overLimit = `notices/acme/${'a'.repeat(1008)}.png`;
    expect(overLimit).toHaveLength(1025);
    expect(resolveBucketObjectPath(overLimit, BUCKET, { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const twoKilobytes = `notices/acme/${'a'.repeat(2000)}.png`;
    expect(resolveBucketObjectPath(twoKilobytes, BUCKET, { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, encodeURIComponent(twoKilobytes)), BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  /**
   * ── The limit is a BYTE limit, so the check counts bytes ───────────────────
   *
   * GCS caps a real object name at 1024 **bytes**, and the check here was written
   * in UTF-16 code units — so a path of 1024 astral-plane characters measured 1024
   * and weighed 4096 bytes.
   *
   * This can only arrive from a REFERENCE value, never from a listing: GCS will not
   * have created the object in the first place, so `getFiles` cannot return such a
   * name. Which is exactly why it matters — the sweep's job is to decide what a
   * stored reference names, and a value it accepts as an object path but which
   * cannot name an object is a value it has mis-measured.
   *
   * Nothing loosens: a byte count is always ≥ the code-unit count, so every path
   * this rejected before is still rejected.
   */
  it('measures the limit in BYTES, so a multi-byte path over 1024 bytes is malformed', () => {
    // 4 bytes each: 300 of them are 1213 bytes but only 613 UTF-16 code units, so a
    // code-unit check let this through as a 1213-byte "object path".
    const astral = `notices/acme/${'\u{1F600}'.repeat(300)}.png`;
    expect(astral.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(astral, 'utf8')).toBeGreaterThan(1024);
    expect(resolveBucketObjectPath(astral, BUCKET, { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    // Same value arriving the way it actually would: percent-encoded inside a
    // Firebase download url.
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, encodeURIComponent(astral)), BUCKET)).toEqual({
      ok: false,
      reason: 'malformed',
    });

    // 3 bytes each: the 2-byte and 3-byte planes are measured the same way.
    const cjk = `notices/acme/${'\u4e2d'.repeat(400)}.png`;
    expect(cjk.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(1024);
    expect(resolveBucketObjectPath(cjk, BUCKET, { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'malformed',
    });

    // And a multi-byte path that fits in 1024 BYTES is still accepted — the change
    // tightens the reject side without narrowing the accept side below the real
    // limit.
    const multiByteWithinLimit = `notices/acme/${'\u{1F600}'.repeat(200)}.png`;
    expect(Buffer.byteLength(multiByteWithinLimit, 'utf8')).toBeLessThanOrEqual(1024);
    expect(resolveBucketObjectPath(multiByteWithinLimit, BUCKET, { allowBarePath: true })).toEqual({
      ok: true,
      objectPath: multiByteWithinLimit,
    });
  });

  it('resolves an object path whose FIRST SEGMENT is literally `o`', () => {
    // The latent bug in `chatMessageWriter.parseStorageObjectPath`: it locates
    // the `o` marker with `indexOf('o')` over the split pathname, so an object
    // whose own first segment is `o` steers the parse. This module anchors the
    // marker by position instead.
    const path = 'o/notices/acme/notice_k_dead0dead0dead0dead0.png';
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, encodeURIComponent(path)), BUCKET)).toEqual({
      ok: true,
      objectPath: path,
    });
    expect(resolveBucketObjectPath(path, BUCKET, { allowBarePath: true })).toEqual({
      ok: true,
      objectPath: path,
    });
  });

  it('resolves an object path containing a literal `%2F` exactly once', () => {
    // The other half of the same latent bug: decoding after a split/rejoin
    // cannot tell a `/` that separated segments from one that arrived as a
    // literal `%2F` inside a single segment. Encoded, the literal `%` is `%25`.
    const path = 'notices/acme/50%2F50 split.png';
    expect(resolveBucketObjectPath(downloadUrl(BUCKET, 'notices%2Facme%2F50%252F50%20split.png'), BUCKET)).toEqual({
      ok: true,
      objectPath: path,
    });
    // A bare path is already the decoded `file.name` spelling and is NOT decoded
    // again, so the literal `%2F` survives untouched.
    expect(resolveBucketObjectPath(path, BUCKET, { allowBarePath: true })).toEqual({
      ok: true,
      objectPath: path,
    });
  });

  it('classifies absent, blank and unreadable values without throwing', () => {
    expect(resolveBucketObjectPath(null, BUCKET)).toEqual({ ok: false, reason: 'empty' });
    expect(resolveBucketObjectPath(undefined, BUCKET)).toEqual({ ok: false, reason: 'empty' });
    expect(resolveBucketObjectPath('', BUCKET, { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(resolveBucketObjectPath('   ', BUCKET, { allowBarePath: true })).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(
      resolveBucketObjectPath(
        {
          toString() {
            throw new Error('unreadable');
          },
        },
        BUCKET
      )
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});

// ---------------------------------------------------------------------------
// `buildFirebaseDownloadUrl`.
// ---------------------------------------------------------------------------
describe('buildFirebaseDownloadUrl', () => {
  it('mirrors videoTranscoder.buildDownloadUrl exactly', () => {
    expect(buildFirebaseDownloadUrl(BUCKET, OBJECT_PATH, 'abc-123')).toBe(
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${ENCODED_OBJECT}?alt=media&token=abc-123`
    );
  });
});

// ---------------------------------------------------------------------------
// The tenant scope guard.
// ---------------------------------------------------------------------------
describe('classifyTenantScopedPath', () => {
  it.each(STORAGE_TENANT_CATEGORIES)('accepts a path under the managed category %s', (category) => {
    expect(classifyTenantScopedPath(`${category}/${TENANT}/object.bin`, TENANT)).toEqual({
      ok: true,
      category,
    });
  });

  it('accepts a deeper path under a managed category', () => {
    expect(classifyTenantScopedPath('notices/acme/audio/notice_audio_k_dead.m4a', TENANT)).toEqual({
      ok: true,
      category: 'notices',
    });
  });

  it('rejects a seventh, unmanaged category', () => {
    expect(classifyTenantScopedPath('invoices/acme/march.pdf', TENANT)).toEqual({
      ok: false,
      reason: 'not_managed_category',
    });
  });

  it('rejects the quarantine namespace, which is deliberately not a managed category', () => {
    expect(classifyTenantScopedPath(`${QUARANTINE_PREFIX}/acme/sweep_1/notices/acme/x.png`, TENANT)).toEqual({
      ok: false,
      reason: 'not_managed_category',
    });
  });

  it('rejects a prefix-colliding tenant in both directions', () => {
    // A naive `startsWith(tenantId)` would let `acme` reach `acme-2`.
    expect(classifyTenantScopedPath('notices/acme-2/x.png', 'acme')).toEqual({
      ok: false,
      reason: 'tenant_mismatch',
    });
    expect(classifyTenantScopedPath('notices/acme/x.png', 'acme-2')).toEqual({
      ok: false,
      reason: 'tenant_mismatch',
    });
    // And each is accepted for its own tenant.
    expect(classifyTenantScopedPath('notices/acme-2/x.png', 'acme-2').ok).toBe(true);
    expect(classifyTenantScopedPath('notices/acme/x.png', 'acme').ok).toBe(true);
  });

  it('rejects a too-shallow path', () => {
    expect(classifyTenantScopedPath('notices/acme', TENANT)).toEqual({
      ok: false,
      reason: 'too_shallow',
    });
    expect(classifyTenantScopedPath('notices/acme/', TENANT)).toEqual({
      ok: false,
      reason: 'too_shallow',
    });
    expect(classifyTenantScopedPath('notices', TENANT)).toEqual({
      ok: false,
      reason: 'too_shallow',
    });
    expect(classifyTenantScopedPath('', TENANT)).toEqual({ ok: false, reason: 'too_shallow' });
  });

  it('rejects a tenant identifier that is not a single plain segment', () => {
    // Otherwise an empty tenant id would match the empty segment of `notices//x`.
    for (const tenantId of ['', '.', '..', 'a/b']) {
      expect(classifyTenantScopedPath('notices//x.png', tenantId).ok).toBe(false);
    }
  });
});

describe('assertTenantScoped', () => {
  it('does not throw for a path inside the tenant scope', () => {
    expect(() => assertTenantScoped('notices/acme/x.png', TENANT)).not.toThrow();
  });

  it('throws a non-retryable TenantScopeViolation carrying the reason', () => {
    let caught: unknown;
    try {
      assertTenantScoped('notices/acme-2/x.png', TENANT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TenantScopeViolation);
    const violation = caught as TenantScopeViolation;
    expect(violation.retryable).toBe(false);
    expect(violation.reason).toBe('tenant_mismatch');
    expect(violation.tenantId).toBe(TENANT);
    expect(violation.objectPath).toBe('notices/acme-2/x.png');
    // The message names the tenant and the reason but not the object path.
    expect(violation.message).not.toContain('notices/acme-2/x.png');
  });
});

// ---------------------------------------------------------------------------
// The quarantine namespace.
// ---------------------------------------------------------------------------
describe('buildQuarantinePath / parseQuarantinePath', () => {
  const SWEEP_ID = 'sweep_1700000000000_ab12cd';

  it('round-trips a live path under every managed category', () => {
    for (const category of STORAGE_TENANT_CATEGORIES) {
      const objectPath = `${category}/${TENANT}/nested/dir/object name.bin`;
      const quarantinePath = buildQuarantinePath({ tenantId: TENANT, sweepId: SWEEP_ID, objectPath });
      expect(quarantinePath).toBe(`${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${objectPath}`);
      expect(parseQuarantinePath(quarantinePath)).toEqual({
        tenantId: TENANT,
        sweepId: SWEEP_ID,
        objectPath,
      });
    }
  });

  it('asserts tenant scope on its input before building a destination', () => {
    expect(() =>
      buildQuarantinePath({ tenantId: TENANT, sweepId: SWEEP_ID, objectPath: 'notices/acme-2/x.png' })
    ).toThrow(TenantScopeViolation);
    expect(() =>
      buildQuarantinePath({ tenantId: TENANT, sweepId: SWEEP_ID, objectPath: 'invoices/acme/x.pdf' })
    ).toThrow(TenantScopeViolation);
  });

  it('refuses a sweepId that is not a single plain path segment', () => {
    // Such an id would make `parseQuarantinePath` a non-inverse, and the
    // hard-delete stage would then reconstruct the wrong original path.
    for (const sweepId of ['', 'a/b', '.', '..', 'a\u0000b']) {
      expect(() =>
        buildQuarantinePath({ tenantId: TENANT, sweepId, objectPath: 'notices/acme/x.png' })
      ).toThrow(TypeError);
    }
  });

  it('rejects every live path shape, for all six categories', () => {
    // This is the disjointness that confines the hard delete: no live object
    // path is in `purgeExpiredQuarantine`'s input domain.
    for (const category of STORAGE_TENANT_CATEGORIES) {
      for (const objectPath of [
        `${category}/${TENANT}/object.bin`,
        `${category}/${TENANT}/nested/object.bin`,
        `${category}/${TENANT}/a/b/c/object.bin`,
      ]) {
        expect(classifyTenantScopedPath(objectPath, TENANT).ok).toBe(true);
        expect(parseQuarantinePath(objectPath)).toBeNull();
      }
    }
  });

  it('rejects malformed quarantine-looking paths', () => {
    for (const path of [
      QUARANTINE_PREFIX,
      `${QUARANTINE_PREFIX}/${TENANT}`,
      `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}`,
      `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/`,
      `${QUARANTINE_PREFIX}//${SWEEP_ID}/notices/acme/x.png`,
      `${QUARANTINE_PREFIX}/${TENANT}//notices/acme/x.png`,
      `_orphan-quarantine-2/${TENANT}/${SWEEP_ID}/notices/acme/x.png`,
      `notices/${QUARANTINE_PREFIX}/${SWEEP_ID}/x.png`,
    ]) {
      expect(parseQuarantinePath(path)).toBeNull();
    }
  });

  it('recovers a nested quarantine path but leaves it outside the scope guard', () => {
    // A quarantine path whose object portion is itself a quarantine path parses
    // structurally, and the purger's own third guard is what refuses it.
    const nested = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${QUARANTINE_PREFIX}/${TENANT}/s2/notices/acme/x.png`;
    const parsed = parseQuarantinePath(nested);
    expect(parsed).not.toBeNull();
    expect(parsed?.objectPath).toBe(`${QUARANTINE_PREFIX}/${TENANT}/s2/notices/acme/x.png`);
    expect(() => assertTenantScoped(parsed!.objectPath, parsed!.tenantId)).toThrow(TenantScopeViolation);
  });
});

// ---------------------------------------------------------------------------
// Profile pictures.
// ---------------------------------------------------------------------------
describe('deriveProfilePicturePath / isDerivedProfilePictureFilename', () => {
  it('derives a path under the tenant profile-pictures prefix', () => {
    const path = deriveProfilePicturePath({ tenantId: TENANT, email: 'Teacher@Example.COM' });
    expect(path).not.toBeNull();
    expect(path?.startsWith(`profile-pictures/${TENANT}/`)).toBe(true);
    expect(classifyTenantScopedPath(path as string, TENANT)).toEqual({
      ok: true,
      category: 'profile-pictures',
    });
    expect(isDerivedProfilePictureFilename((path as string).split('/').pop() as string)).toBe(true);
  });

  it('returns null when the email is blank after the writer\'s own normalisation', () => {
    expect(deriveProfilePicturePath({ tenantId: TENANT, email: '' })).toBeNull();
    expect(deriveProfilePicturePath({ tenantId: TENANT, email: '   ' })).toBeNull();
  });

  it('accepts exactly the 20-hex-plus-.jpg filename shape', () => {
    expect(isDerivedProfilePictureFilename('0123456789abcdef0123.jpg')).toBe(true);
    for (const name of [
      '0123456789abcdef012.jpg', // 19 hex
      '0123456789abcdef01234.jpg', // 21 hex
      '0123456789ABCDEF0123.jpg', // uppercase
      '0123456789abcdefzzzz.jpg', // non-hex
      '0123456789abcdef0123.png', // wrong extension
      '0123456789abcdef0123.jpeg',
      ' 0123456789abcdef0123.jpg',
      '0123456789abcdef0123.jpg ',
      'a/0123456789abcdef0123.jpg',
      '0123456789abcdef0123.jpg\n',
      '',
    ]) {
      expect(isDerivedProfilePictureFilename(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The constants themselves.
// ---------------------------------------------------------------------------
describe('constants', () => {
  it('holds the six managed categories, with student_profiles kept in snake_case', () => {
    expect(STORAGE_TENANT_CATEGORIES).toEqual([
      'chat-files',
      'tenant-branding',
      'notices',
      'student_profiles',
      'receipts',
      'profile-pictures',
    ]);
  });

  it('keeps the quarantine prefix out of the managed categories', () => {
    // Simultaneously what keeps quarantined bytes out of the quota sum, what
    // makes `/storage/delete` reject a quarantine path, and what makes the two
    // path domains disjoint.
    expect(STORAGE_TENANT_CATEGORIES).not.toContain(QUARANTINE_PREFIX);
    expect(QUARANTINE_PREFIX).toBe('_orphan-quarantine');
  });
});
