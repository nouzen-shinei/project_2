// Feature: upload-idempotency, Task 4.6: `POST /storage/upload` query schema — `uploadKey` handling
//
// Pins the accept/reject boundary of the optional `uploadKey` query parameter
// against the REAL schema the route parses with (`storageUploadQuerySchema`,
// exported from `../app`), plus the hash derivation the route feeds it into.
// Requirements 2.8, 6.8, 10.8.
//
// The property that matters here: an out-of-bounds `uploadKey` must surface as
// `400 validation_failed` with an issue pointing at `uploadKey`. It must NOT be
// silently dropped, because a dropped key downgrades the upload to a legacy
// timestamped path — i.e. back to the orphan-on-retry bug this feature exists to
// fix, with the caller believing it opted in.

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import { storageUploadQuerySchema } from '../app';
import { deriveUploadKeyHash } from '../lib/uploadObjectPath';

/** Documented bounds (design: "trimmed, 8..200 chars"). */
const MIN_UPLOAD_KEY_LENGTH = 8;
const MAX_UPLOAD_KEY_LENGTH = 200;

const key = (length: number): string => 'k'.repeat(length);

/** A minimal query that parses cleanly, so each case varies only `uploadKey`. */
const baseQuery = {
  tenantId: 'acme',
  purpose: 'receipt' as const,
  feeId: 'fee_77',
  filename: 'march.pdf',
};

const parseWith = (uploadKey: unknown) =>
  storageUploadQuerySchema.safeParse({ ...baseQuery, uploadKey });

const uploadKeyIssues = (result: ReturnType<typeof parseWith>) =>
  result.success ? [] : result.error.issues.filter((issue) => issue.path.join('.') === 'uploadKey');

describe('storageUploadQuerySchema — uploadKey', () => {
  it('accepts an absent uploadKey and yields undefined (the legacy path, Req 2.6)', () => {
    const result = storageUploadQuerySchema.safeParse(baseQuery);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.uploadKey).toBeUndefined();
    // The rest of the query is untouched by the new field.
    expect(result.data.tenantId).toBe('acme');
    expect(result.data.purpose).toBe('receipt');
    expect(result.data.feeId).toBe('fee_77');
  });

  it('accepts a key of exactly the minimum length and rejects one character less (Req 2.8, 6.8)', () => {
    const atMin = parseWith(key(MIN_UPLOAD_KEY_LENGTH));
    expect(atMin.success).toBe(true);
    if (atMin.success) expect(atMin.data.uploadKey).toBe(key(MIN_UPLOAD_KEY_LENGTH));

    const belowMin = parseWith(key(MIN_UPLOAD_KEY_LENGTH - 1));
    expect(belowMin.success).toBe(false);
    expect(uploadKeyIssues(belowMin)).toHaveLength(1);
  });

  it('accepts a key of exactly the maximum length and rejects one character more (Req 2.8, 6.8)', () => {
    const atMax = parseWith(key(MAX_UPLOAD_KEY_LENGTH));
    expect(atMax.success).toBe(true);
    if (atMax.success) expect(atMax.data.uploadKey).toHaveLength(MAX_UPLOAD_KEY_LENGTH);

    const aboveMax = parseWith(key(MAX_UPLOAD_KEY_LENGTH + 1));
    expect(aboveMax.success).toBe(false);
    expect(uploadKeyIssues(aboveMax)).toHaveLength(1);
  });

  it('trims before the length check: padding cannot buy a short key past the minimum', () => {
    // Long enough on its own, padded: parses, and the padding is gone from the
    // value the route hashes.
    const padded = parseWith(`   ${key(MIN_UPLOAD_KEY_LENGTH)}  `);
    expect(padded.success).toBe(true);
    if (padded.success) expect(padded.data.uploadKey).toBe(key(MIN_UPLOAD_KEY_LENGTH));

    // Long enough ONLY because of the padding: rejected, not silently accepted
    // as a 4-character key (Req 6.8 — the bound applies after trimming).
    const paddedShort = parseWith(`  ${key(4)}      `);
    expect(paddedShort.success).toBe(false);
    expect(uploadKeyIssues(paddedShort)).toHaveLength(1);

    // Same interaction at the upper bound: trailing whitespace on a max-length
    // key is trimmed away rather than pushing it over the limit.
    const paddedAtMax = parseWith(`  ${key(MAX_UPLOAD_KEY_LENGTH)}  `);
    expect(paddedAtMax.success).toBe(true);
    if (paddedAtMax.success) expect(paddedAtMax.data.uploadKey).toHaveLength(MAX_UPLOAD_KEY_LENGTH);

    // Whitespace-only is rejected outright (it would trim to an empty key).
    const blank = parseWith('          ');
    expect(blank.success).toBe(false);
    expect(uploadKeyIssues(blank)).toHaveLength(1);
  });

  it('rejects an out-of-bounds key instead of dropping it — a 400, never a silent legacy downgrade', () => {
    const rejected = parseWith(key(MIN_UPLOAD_KEY_LENGTH - 1));
    expect(rejected.success).toBe(false);
    if (rejected.success) return;

    // This is exactly what the route turns into
    // `400 { error: 'validation_failed', issues }`.
    const issues = rejected.error.issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.path.join('.') === 'uploadKey')).toBe(true);

    // And the failure is attributable to `uploadKey` alone: the identical query
    // without the field parses fine, so the schema is not quietly ignoring the
    // bad value and continuing on the legacy path.
    const withoutKey = storageUploadQuerySchema.safeParse(baseQuery);
    expect(withoutKey.success).toBe(true);
  });

  it('rejects non-string shapes', () => {
    for (const value of [12345678, true, ['abcdefgh'], { key: 'abcdefgh' }, null]) {
      const result = parseWith(value);
      expect(result.success).toBe(false);
      expect(uploadKeyIssues(result)).toHaveLength(1);
    }
  });
});

describe('deriveUploadKeyHash — pinned to the schema boundary', () => {
  const scope = { tenantId: 'acme', purpose: 'receipt' as const, actorUid: 'uid_123' };

  it('returns null when no uploadKey was supplied (the legacy path)', () => {
    expect(deriveUploadKeyHash({ ...scope, uploadKey: undefined })).toBeNull();
    expect(deriveUploadKeyHash({ ...scope, uploadKey: null })).toBeNull();
  });

  it('returns a 20-hex-character digest for a schema-accepted key (Req 6.1)', () => {
    const parsed = storageUploadQuerySchema.safeParse({
      ...baseQuery,
      uploadKey: key(MIN_UPLOAD_KEY_LENGTH),
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const hash = deriveUploadKeyHash({ ...scope, uploadKey: parsed.data.uploadKey });
    expect(hash).toMatch(/^[0-9a-f]{20}$/);
    // Hex only: no character of the raw key reaches the path (Req 6.3).
    expect(hash).not.toContain('k');
  });

  it('hashes the trimmed value, so a padded key resolves to the same object', () => {
    const padded = storageUploadQuerySchema.safeParse({
      ...baseQuery,
      uploadKey: `  ${key(MIN_UPLOAD_KEY_LENGTH)} `,
    });
    expect(padded.success).toBe(true);
    if (!padded.success) return;

    expect(deriveUploadKeyHash({ ...scope, uploadKey: padded.data.uploadKey })).toBe(
      deriveUploadKeyHash({ ...scope, uploadKey: key(MIN_UPLOAD_KEY_LENGTH) })
    );
  });
});

// ── displayName (upload-idempotency spec, background-transport gap) ───────────
//
// `displayName` splits the user-visible name out of `filename`, so the native
// background transport can send a DETERMINISTIC `filename` (one object per send)
// without renaming what the recipient sees. Same accept/reject discipline as
// `uploadKey`: an out-of-bounds value is a hard `400 validation_failed`, never a
// silent drop that would put a machine name in a bubble or a share sheet.
describe('storageUploadQuerySchema — displayName', () => {
  /** Bound justification: the single-path-component limit on ext4 / APFS / NTFS. */
  const MAX_DISPLAY_NAME_LENGTH = 255;

  const parseDisplayName = (displayName: unknown) =>
    storageUploadQuerySchema.safeParse({ ...baseQuery, displayName });

  const displayNameIssues = (result: ReturnType<typeof parseDisplayName>) =>
    result.success
      ? []
      : result.error.issues.filter((issue) => issue.path.join('.') === 'displayName');

  const name = (length: number): string => `${'d'.repeat(Math.max(0, length - 4))}.jpg`;

  it('accepts an absent displayName and yields undefined (every consumer falls back to filename)', () => {
    const result = storageUploadQuerySchema.safeParse(baseQuery);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.displayName).toBeUndefined();
    // The parameter is purely additive: nothing else about the query shifts.
    expect(result.data.filename).toBe('march.pdf');
    expect(result.data.tenantId).toBe('acme');
    expect(result.data.purpose).toBe('receipt');
  });

  it('accepts a realistic OS filename unchanged', () => {
    const result = parseDisplayName('IMG_0042 (1).jpeg');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.displayName).toBe('IMG_0042 (1).jpeg');
  });

  it('accepts a blank value rather than 400ing (it degrades to the filename fallback)', () => {
    // Deliberately no `.min()`: whitespace-only must behave like absent, because
    // the display-name fallback chain already handles a falsy value.
    for (const blank of ['', '   ']) {
      const result = parseDisplayName(blank);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.displayName).toBe('');
    }
  });

  it('accepts exactly the maximum length and rejects one character more', () => {
    const atMax = parseDisplayName(name(MAX_DISPLAY_NAME_LENGTH));
    expect(atMax.success).toBe(true);
    if (atMax.success) expect(atMax.data.displayName).toHaveLength(MAX_DISPLAY_NAME_LENGTH);

    const aboveMax = parseDisplayName(name(MAX_DISPLAY_NAME_LENGTH + 1));
    expect(aboveMax.success).toBe(false);
    // Surfaces through the route's existing `validation_failed` branch, attributed
    // to `displayName`.
    expect(displayNameIssues(aboveMax)).toHaveLength(1);

    const withoutField = storageUploadQuerySchema.safeParse(baseQuery);
    expect(withoutField.success).toBe(true);
  });

  it('trims before the length check, so padding cannot push a name over the bound', () => {
    const padded = parseDisplayName(`  ${name(MAX_DISPLAY_NAME_LENGTH)}   `);
    expect(padded.success).toBe(true);
    if (padded.success) expect(padded.data.displayName).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });

  it('rejects non-string shapes', () => {
    for (const value of [42, true, ['a.jpg'], { name: 'a.jpg' }, null]) {
      const result = parseDisplayName(value);
      expect(result.success).toBe(false);
      expect(displayNameIssues(result)).toHaveLength(1);
    }
  });

  it('parses alongside a deterministic filename + uploadKey — the background transport shape', () => {
    const result = storageUploadQuerySchema.safeParse({
      tenantId: 'acme',
      purpose: 'chat',
      conversationFolder: 'c_abcdef1234',
      filename: 'pick_pm_1712345678901_abc123_0k1j2h3g4f5d6s.jpg',
      displayName: 'IMG_0042.jpg',
      createMessage: '1',
      clientMsgId: 'pm_1712345678901_abc123',
      recipientId: 'partner@example.com',
      mediaKind: 'attachment',
      uploadKey: 'pm_1712345678901_abc123',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Two distinct jobs, two distinct values.
    expect(result.data.filename).toBe('pick_pm_1712345678901_abc123_0k1j2h3g4f5d6s.jpg');
    expect(result.data.displayName).toBe('IMG_0042.jpg');
    expect(result.data.uploadKey).toBe('pm_1712345678901_abc123');
  });
});
