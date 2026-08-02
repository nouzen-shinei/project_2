// Feature: upload-idempotency, Property 1: Deterministic paths are retry-stable — for any purpose, tenant, actor, filename and uploadKey, repeated calls to resolveUploadObjectPath with the same inputs produce the same objectPath, regardless of the injected now and randomSuffix values.
/**
 * Property-based tests for the pure path-derivation module
 * `src/lib/uploadObjectPath.ts` (upload-idempotency, design Properties 1, 2, 3,
 * 10 and 11).
 *
 * These drive the real, exported `resolveUploadObjectPath` /
 * `deriveUploadKeyHash` — no Express, no Firebase, no mocking. Each property
 * runs at least 100 fast-check iterations and is tagged with the exact design
 * property text on its own line above the suite it covers.
 *
 * Generators deliberately cover the hostile / awkward corners of the real input
 * space: Unicode filenames, 300-character filenames, filenames with no
 * extension, dotfiles, blank and whitespace-only values, traversal-shaped fee
 * ids and conversation folders, unmapped and mixed-case content types, and
 * whitespace-padded / non-ASCII upload keys.
 *
 * Property 3's legacy-format expectation is an INDEPENDENT reconstruction of the
 * formats `app.ts` produces today (`app.ts:14142`–`:14163`), written from those
 * lines rather than by calling the module a second time — the point is to pin
 * the wire format, so a vacuous self-comparison would prove nothing.
 */

import crypto from 'node:crypto';

import * as fc from 'fast-check';

import {
  deriveUploadKeyHash,
  resolveUploadObjectPath,
  type ResolveUploadObjectPathArgs,
  type StorageUploadPurpose,
} from '../lib/uploadObjectPath';

const NUM_RUNS = 100;

/** The full `StorageUploadPurpose` union, enumerated for exhaustiveness checks. */
const ALL_PURPOSES: readonly StorageUploadPurpose[] = [
  'chat',
  'tenantLogo',
  'noticeImage',
  'noticeAudio',
  'studentProfile',
  'receipt',
  'profilePicture',
];

/** `profilePicture` is keyed on email, not on the upload key — exempt where noted. */
const KEYED_PURPOSES: readonly StorageUploadPurpose[] = ALL_PURPOSES.filter(
  (p) => p !== 'profilePicture'
);

/** The six managed prefixes from `STORAGE_TENANT_CATEGORIES` (`app.ts:13825`). */
const MANAGED_CATEGORIES = [
  'chat-files',
  'tenant-branding',
  'notices',
  'student_profiles',
  'receipts',
  'profile-pictures',
] as const;

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const purposeArb = fc.constantFrom(...ALL_PURPOSES);
const keyedPurposeArb = fc.constantFrom(...KEYED_PURPOSES);

/** Server-derived tenant ids (never client input, so realistic shapes only). */
const tenantIdArb = fc.constantFrom(
  'acme',
  'tenant_1',
  'T-42',
  'a',
  'tenant.with.dots',
  '0123456789abcdef'
);

const actorUidArb = fc.constantFrom('uid_123', 'UID-abc', 'u', 'x'.repeat(64));

/**
 * Filenames: Unicode, very long, no extension, dotfiles, blank / whitespace,
 * multi-dot, bare dot segments, plus arbitrary ASCII and arbitrary graphemes.
 */
const filenameArb = fc.oneof(
  fc.constantFrom(
    'march.pdf',
    'photo.JPG',
    'archive',
    '.env',
    'file..tar.gz',
    '.',
    '..',
    '',
    '   ',
    '\t\n',
    `${'a'.repeat(300)}.png`,
    'ファイル名.png',
    'naïve résumé.docx',
    'emoji 🎉.png',
    'sub/dir/name.png',
    '..\\windows.png',
    'nul\u0000byte.png'
  ),
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'grapheme', maxLength: 30 })
);

const optionalFilenameArb = fc.option(filenameArb, { nil: undefined });

/** Content types: every mapped value, unmapped ones, casing / padding, blanks. */
const contentTypeArb = fc.oneof(
  fc.constantFrom(
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/svg+xml',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/mp4',
    'audio/m4a',
    'application/pdf',
    '  IMAGE/PNG  ',
    'Application/PDF',
    'application/octet-stream',
    'video/mp4',
    'text/plain',
    ''
  ),
  fc.constant(null),
  fc.constant(undefined),
  fc.string({ maxLength: 24 })
);

const conversationFolderArb = fc.oneof(
  fc.constantFrom(
    'c_abcdef1234567890abcd',
    'c_short',
    'conv-1',
    'alice@example.com|bob@example.com',
    '../../escape',
    '',
    '   ',
    '.',
    '..',
    'разговор'
  ),
  fc.option(fc.string({ maxLength: 24 }), { nil: undefined })
);

const feeIdArb = fc.oneof(
  fc.constantFrom('fee_77', 'FEE-2024.01', '../../other-tenant', '', '  ', '.', '..', '料金'),
  fc.option(fc.string({ maxLength: 20 }), { nil: undefined })
);

/** Emails that survive sanitization to a non-empty key (profilePicture is ok). */
const usableEmailArb = fc.constantFrom(
  'a@b.com',
  'Mixed.Case@Example.COM',
  '  spaced  user @example.com ',
  'ünïcode@example.com',
  'x',
  '@'
);

/** Emails that sanitize to empty ⇒ `missing_email`. */
const blankEmailArb = fc.constantFrom(undefined, '', '   ', '\t\n', ' \r ');

/** Upload keys the endpoint would accept (8..200 chars after trimming). */
const uploadKeyArb = fc.oneof(
  fc
    .string({ minLength: 8, maxLength: 200 })
    .filter((s) => s.trim().length >= 1),
  fc.constantFrom(
    'receipt_9f2c41e0-7f3a-4d21-9c5e-1b8a0c6d5e42',
    '   padded-key-value   ',
    'ключ-загрузки-1234',
    'k'.repeat(200),
    'chat_msg_1700000000000_abc',
    '../../../etc/passwd-key'
  )
);

const nowArb = fc.integer({ min: 1, max: 4_000_000_000_000 });

/** The route passes `crypto.randomBytes(3).toString('hex')` — 6 hex chars. */
const HEX = '0123456789abcdef'.split('');
const randomSuffixArb = fc
  .array(fc.constantFrom(...HEX), { minLength: 2, maxLength: 8 })
  .map((chars) => chars.join(''));

// ---------------------------------------------------------------------------
// Independent legacy-format oracle (Property 3)
//
// Transcribed from today's `app.ts` upload route so the assertion pins the wire
// format rather than re-deriving it from the module under test:
//   :14142 chat-files/{t}/{conv}/{ts}_{safeName}
//   :14144 tenant-branding/{t}/logo_{ts}.{ext}
//   :14146 notices/{t}/notice_{ts}_{rand}.{ext}
//   :14148 notices/{t}/audio/notice_audio_{ts}_{rand}.{ext}
//   :14150 student_profiles/{t}/{ts}_profile.{ext}
//   :14154 receipts/{t}/{feeId}/{ts}_{safeName}
// ---------------------------------------------------------------------------

const LEGACY_EXT_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'application/pdf': 'pdf',
};

function oracleSanitize(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function oracleExt(contentType: string | null | undefined, fallback: string): string {
  const ct = (contentType ?? '').trim().toLowerCase();
  // Own-property lookup only. `app.ts` (and the module under test) use an
  // if-chain, so an unmapped content type ALWAYS falls back. A bare `[ct]` read
  // would resolve `__proto__` / `constructor` through `Object.prototype` and
  // return a non-string, making this oracle diverge from the code it pins.
  return Object.prototype.hasOwnProperty.call(LEGACY_EXT_BY_CONTENT_TYPE, ct)
    ? LEGACY_EXT_BY_CONTENT_TYPE[ct]
    : fallback;
}

function oracleSha20(value: string): string {
  return crypto.createHash('sha256').update(value ?? '', 'utf8').digest('hex').slice(0, 20);
}

function oracleConversationFolder(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return 'unassigned';
  if (trimmed.startsWith('c_') && trimmed.length >= 10) return trimmed;
  return `c_${oracleSha20(trimmed)}`;
}

/**
 * A value used as a WHOLE path segment. `.` and `..` fall back instead of being
 * emitted verbatim: emitting them would create a relative-path segment, which
 * design Property 4 / Requirement 6.5 forbid. Every other input is
 * byte-identical to today's `app.ts` output.
 */
function oracleWholeSegment(value: string | undefined, fallback: string): string {
  const sanitized = oracleSanitize(value || fallback) || fallback;
  return sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

function expectedLegacyPath(args: {
  purpose: Exclude<StorageUploadPurpose, 'profilePicture'>;
  tenantId: string;
  filename?: string;
  contentType?: string | null;
  conversationFolder?: string;
  feeId?: string;
  /** Accepted (and unused) so a purpose-input bag can be spread in verbatim. */
  email?: string;
  now: number;
  randomSuffix: string;
}): string {
  const { tenantId, now: ts } = args;
  const filename = oracleSanitize(args.filename || 'file');
  const extFallback = filename.split('.').pop() || 'bin';
  const ext = oracleExt(args.contentType, extFallback);
  const safeExt = oracleSanitize(ext) || 'bin';
  const rand = oracleSanitize(args.randomSuffix);

  switch (args.purpose) {
    case 'chat': {
      const rawFolder = oracleSanitize(args.conversationFolder || 'unassigned') || 'unassigned';
      const folder = oracleConversationFolder(rawFolder);
      const safeName = filename || `file.${safeExt}`;
      return `chat-files/${tenantId}/${folder}/${ts}_${safeName}`;
    }
    case 'tenantLogo':
      return `tenant-branding/${tenantId}/logo_${ts}.${safeExt}`;
    case 'noticeImage':
      return `notices/${tenantId}/notice_${ts}_${rand}.${safeExt}`;
    case 'noticeAudio':
      return `notices/${tenantId}/audio/notice_audio_${ts}_${rand}.${safeExt}`;
    case 'studentProfile':
      return `student_profiles/${tenantId}/${ts}_profile.${safeExt}`;
    case 'receipt': {
      const feeId = oracleWholeSegment(args.feeId, 'unknown');
      const safeName = filename || `receipt.${safeExt}`;
      return `receipts/${tenantId}/${feeId}/${ts}_${safeName}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Per-purpose required inputs, so every purpose can resolve successfully. */
interface PurposeInputs {
  conversationFolder?: string;
  feeId?: string;
  email?: string;
}

const purposeInputsArb = (purpose: StorageUploadPurpose): fc.Arbitrary<PurposeInputs> => {
  if (purpose === 'chat') return conversationFolderArb.map((conversationFolder) => ({ conversationFolder }));
  if (purpose === 'receipt') return feeIdArb.map((feeId) => ({ feeId }));
  if (purpose === 'profilePicture') return usableEmailArb.map((email) => ({ email }));
  return fc.constant({});
};

function assertPathShape(objectPath: string, tenantId: string): void {
  const segments = objectPath.split('/');
  expect(objectPath.length).toBeGreaterThan(0);
  expect(objectPath.startsWith('/')).toBe(false);
  expect(MANAGED_CATEGORIES).toContain(segments[0] as (typeof MANAGED_CATEGORIES)[number]);
  expect(segments[1]).toBe(tenantId);
  expect(segments.some((s) => s.length === 0)).toBe(false);
  expect(segments.includes('..')).toBe(false);
  expect(segments.includes('.')).toBe(false);
}

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

// Feature: upload-idempotency, Property 1: Deterministic paths are retry-stable — for any purpose, tenant, actor, filename and uploadKey, repeated calls to resolveUploadObjectPath with the same inputs produce the same objectPath, regardless of the injected now and randomSuffix values.
describe('Property 1: Deterministic paths are retry-stable', () => {
  it('produces the same objectPath for the same inputs regardless of now / randomSuffix', () => {
    fc.assert(
      fc.property(
        purposeArb.chain((purpose) =>
          fc.record({
            purpose: fc.constant(purpose),
            inputs: purposeInputsArb(purpose),
            tenantId: tenantIdArb,
            actorUid: actorUidArb,
            filename: optionalFilenameArb,
            contentType: contentTypeArb,
            uploadKey: uploadKeyArb,
            // Distinct by construction, so "regardless of now / randomSuffix"
            // is actually exercised on every run.
            nows: fc.tuple(nowArb, nowArb).filter(([a, b]) => a !== b),
            rands: fc.tuple(randomSuffixArb, randomSuffixArb).filter(([a, b]) => a !== b),
          })
        ),
        (c) => {
          const uploadKeyHash = deriveUploadKeyHash({
            uploadKey: c.uploadKey,
            tenantId: c.tenantId,
            purpose: c.purpose,
            actorUid: c.actorUid,
          });
          expect(uploadKeyHash).not.toBeNull();

          const base = {
            purpose: c.purpose,
            tenantId: c.tenantId,
            filename: c.filename,
            contentType: c.contentType,
            uploadKeyHash,
            ...c.inputs,
          };

          const [nowA, nowB] = c.nows;
          const [randA, randB] = c.rands;

          const first = resolveUploadObjectPath({ ...base, now: nowA, randomSuffix: randA });
          const second = resolveUploadObjectPath({ ...base, now: nowB, randomSuffix: randB });
          // Same inputs a third time, with the clock/random of the first attempt.
          const third = resolveUploadObjectPath({ ...base, now: nowA, randomSuffix: randA });

          expect(first.ok).toBe(true);
          expect(second.ok).toBe(true);
          expect(third.ok).toBe(true);
          if (!first.ok || !second.ok || !third.ok) return;

          expect(first.deterministic).toBe(true);
          // Stability across a different clock AND a different random suffix is
          // exactly the retry case: neither injected value may reach the path.
          expect(second.objectPath).toBe(first.objectPath);
          expect(third.objectPath).toBe(first.objectPath);

          assertPathShape(first.objectPath, c.tenantId);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

// Feature: upload-idempotency, Property 2: Distinct upload keys produce distinct paths — for any two distinct uploadKey values with all other inputs equal, the resolved deterministic objectPath values differ.
describe('Property 2: Distinct upload keys produce distinct paths', () => {
  it('resolves two distinct upload keys to different object paths', () => {
    fc.assert(
      fc.property(
        keyedPurposeArb.chain((purpose) =>
          fc.record({
            purpose: fc.constant(purpose),
            inputs: purposeInputsArb(purpose),
            tenantId: tenantIdArb,
            actorUid: actorUidArb,
            filename: optionalFilenameArb,
            contentType: contentTypeArb,
            keys: fc
              .tuple(uploadKeyArb, uploadKeyArb)
              .filter(([a, b]) => a.trim() !== b.trim()),
            now: nowArb,
            randomSuffix: randomSuffixArb,
          })
        ),
        (c) => {
          const [rawKeyA, rawKeyB] = c.keys;
          const scope = { tenantId: c.tenantId, purpose: c.purpose, actorUid: c.actorUid };

          // Both keys are hashed with the SAME scope: only the raw key differs.
          const hashA = deriveUploadKeyHash({ ...scope, uploadKey: rawKeyA });
          const hashB = deriveUploadKeyHash({ ...scope, uploadKey: rawKeyB });
          expect(hashA).not.toBeNull();
          expect(hashB).not.toBeNull();
          expect(hashB).not.toBe(hashA);

          const base = {
            purpose: c.purpose,
            tenantId: c.tenantId,
            filename: c.filename,
            contentType: c.contentType,
            now: c.now,
            randomSuffix: c.randomSuffix,
            ...c.inputs,
          };

          const a = resolveUploadObjectPath({ ...base, uploadKeyHash: hashA });
          const b = resolveUploadObjectPath({ ...base, uploadKeyHash: hashB });

          expect(a.ok).toBe(true);
          expect(b.ok).toBe(true);
          if (!a.ok || !b.ok) return;

          expect(b.objectPath).not.toBe(a.objectPath);
          assertPathShape(a.objectPath, c.tenantId);
          assertPathShape(b.objectPath, c.tenantId);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('documents the profilePicture exemption: its path ignores the upload key entirely', () => {
    fc.assert(
      fc.property(
        fc.record({
          tenantId: tenantIdArb,
          actorUid: actorUidArb,
          email: usableEmailArb,
          filename: optionalFilenameArb,
          contentType: contentTypeArb,
          keys: fc.tuple(uploadKeyArb, uploadKeyArb).filter(([a, b]) => a.trim() !== b.trim()),
          now: nowArb,
          randomSuffix: randomSuffixArb,
        }),
        (c) => {
          const scope = {
            tenantId: c.tenantId,
            purpose: 'profilePicture' as const,
            actorUid: c.actorUid,
          };
          const base = {
            purpose: 'profilePicture' as const,
            tenantId: c.tenantId,
            email: c.email,
            filename: c.filename,
            contentType: c.contentType,
            now: c.now,
            randomSuffix: c.randomSuffix,
          };

          const a = resolveUploadObjectPath({
            ...base,
            uploadKeyHash: deriveUploadKeyHash({ ...scope, uploadKey: c.keys[0] }),
          });
          const b = resolveUploadObjectPath({
            ...base,
            uploadKeyHash: deriveUploadKeyHash({ ...scope, uploadKey: c.keys[1] }),
          });

          if (!a.ok || !b.ok) throw new Error('profilePicture with a usable email must resolve');

          // Requirement 1.5: the key is accepted and deliberately ignored — one
          // stable object per user, keyed on email.
          expect(b.objectPath).toBe(a.objectPath);
          expect(a.objectPath).toMatch(
            new RegExp(`^profile-pictures/${escapeRegExp(c.tenantId)}/[0-9a-f]{20}\\.jpg$`)
          );
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

// Feature: upload-idempotency, Property 3: Absent upload key reproduces legacy paths exactly — for any purpose other than profilePicture and any inputs, calling resolveUploadObjectPath with uploadKeyHash === null produces a path matching that purpose's current timestamped/randomized format character-for-character.
describe('Property 3: Absent upload key reproduces legacy paths exactly', () => {
  it('matches the independently reconstructed legacy format character-for-character', () => {
    fc.assert(
      fc.property(
        keyedPurposeArb.chain((purpose) =>
          fc.record({
            purpose: fc.constant(purpose),
            inputs: purposeInputsArb(purpose),
            tenantId: tenantIdArb,
            filename: optionalFilenameArb,
            contentType: contentTypeArb,
            now: nowArb,
            randomSuffix: randomSuffixArb,
          })
        ),
        (c) => {
          const resolved = resolveUploadObjectPath({
            purpose: c.purpose,
            tenantId: c.tenantId,
            filename: c.filename,
            contentType: c.contentType,
            uploadKeyHash: null,
            now: c.now,
            randomSuffix: c.randomSuffix,
            ...c.inputs,
          });

          expect(resolved.ok).toBe(true);
          if (!resolved.ok) return;

          const expected = expectedLegacyPath({
            purpose: c.purpose as Exclude<StorageUploadPurpose, 'profilePicture'>,
            tenantId: c.tenantId,
            filename: c.filename,
            contentType: c.contentType,
            now: c.now,
            randomSuffix: c.randomSuffix,
            ...c.inputs,
          });

          expect(resolved.objectPath).toBe(expected);
          expect(resolved.deterministic).toBe(false);
          // Every legacy variable segment carries the injected timestamp, which
          // is what keeps the legacy namespace disjoint from the `k_` namespace.
          expect(resolved.objectPath).toContain(`${c.now}`);
          assertPathShape(resolved.objectPath, c.tenantId);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

// Feature: upload-idempotency, Property 10: Purposes are exhaustively mapped — for any member of the StorageUploadPurpose union, resolveUploadObjectPath returns ok: true when its required inputs are present (and ok: false with a specific error code otherwise) — it never falls through to an empty path.
describe('Property 10: Purposes are exhaustively mapped', () => {
  it('resolves every purpose whose required inputs are present, keyed and unkeyed', () => {
    fc.assert(
      fc.property(
        purposeArb.chain((purpose) =>
          fc.record({
            purpose: fc.constant(purpose),
            inputs: purposeInputsArb(purpose),
            tenantId: tenantIdArb,
            actorUid: actorUidArb,
            filename: optionalFilenameArb,
            contentType: contentTypeArb,
            uploadKey: fc.option(uploadKeyArb, { nil: undefined }),
            now: nowArb,
            randomSuffix: randomSuffixArb,
          })
        ),
        (c) => {
          const uploadKeyHash = deriveUploadKeyHash({
            uploadKey: c.uploadKey,
            tenantId: c.tenantId,
            purpose: c.purpose,
            actorUid: c.actorUid,
          });

          const resolved = resolveUploadObjectPath({
            purpose: c.purpose,
            tenantId: c.tenantId,
            filename: c.filename,
            contentType: c.contentType,
            uploadKeyHash,
            now: c.now,
            randomSuffix: c.randomSuffix,
            ...c.inputs,
          });

          expect(resolved.ok).toBe(true);
          if (!resolved.ok) return;

          expect(resolved.objectPath.trim()).not.toBe('');
          expect(resolved.deterministic).toBe(
            uploadKeyHash !== null || c.purpose === 'profilePicture'
          );
          assertPathShape(resolved.objectPath, c.tenantId);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('returns missing_email (never an empty path) when profilePicture has no usable email', () => {
    fc.assert(
      fc.property(
        fc.record({
          tenantId: tenantIdArb,
          actorUid: actorUidArb,
          email: blankEmailArb,
          filename: optionalFilenameArb,
          contentType: contentTypeArb,
          uploadKey: fc.option(uploadKeyArb, { nil: undefined }),
          now: nowArb,
          randomSuffix: randomSuffixArb,
        }),
        (c) => {
          const resolved = resolveUploadObjectPath({
            purpose: 'profilePicture',
            tenantId: c.tenantId,
            email: c.email,
            filename: c.filename,
            contentType: c.contentType,
            uploadKeyHash: deriveUploadKeyHash({
              uploadKey: c.uploadKey,
              tenantId: c.tenantId,
              purpose: 'profilePicture',
              actorUid: c.actorUid,
            }),
            now: c.now,
            randomSuffix: c.randomSuffix,
          });

          expect(resolved.ok).toBe(false);
          if (resolved.ok) return;
          expect(resolved.error).toBe('missing_email');
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('returns invalid_upload_purpose (never an empty path) for an unmapped purpose', () => {
    const unmappedPurposeArb = fc.oneof(
      fc.constantFrom<unknown>(
        '',
        '   ',
        'unknown',
        'CHAT',
        'chatty',
        'profilepicture',
        'Receipt',
        null,
        undefined,
        42,
        true,
        {}
      ),
      fc.string({ maxLength: 16 }).filter((s) => !ALL_PURPOSES.includes(s as StorageUploadPurpose))
    );

    fc.assert(
      fc.property(
        fc.record({
          purpose: unmappedPurposeArb,
          tenantId: tenantIdArb,
          filename: optionalFilenameArb,
          contentType: contentTypeArb,
          email: usableEmailArb,
          feeId: feeIdArb,
          conversationFolder: conversationFolderArb,
          uploadKeyHash: fc.option(fc.constant('a1b2c3d4e5f60718293a'), { nil: null }),
          now: nowArb,
          randomSuffix: randomSuffixArb,
        }),
        (c) => {
          const resolved = resolveUploadObjectPath(
            c as unknown as ResolveUploadObjectPathArgs
          );

          expect(resolved.ok).toBe(false);
          if (resolved.ok) return;
          expect(resolved.error).toBe('invalid_upload_purpose');
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

// Feature: upload-idempotency, Property 11: Extension and filename sanitization is total — for any contentType and any filename, the resolved path's extension and name segments consist only of [A-Za-z0-9._-] and are non-empty (falling back to bin/file as today).
describe('Property 11: Extension and filename sanitization is total', () => {
  it('always yields a non-empty, charset-restricted extension and name segment', () => {
    fc.assert(
      fc.property(
        purposeArb.chain((purpose) =>
          fc.record({
            purpose: fc.constant(purpose),
            inputs: purposeInputsArb(purpose),
            tenantId: tenantIdArb,
            actorUid: actorUidArb,
            filename: optionalFilenameArb,
            contentType: contentTypeArb,
            uploadKey: fc.option(uploadKeyArb, { nil: undefined }),
            now: nowArb,
            randomSuffix: randomSuffixArb,
          })
        ),
        (c) => {
          const resolved = resolveUploadObjectPath({
            purpose: c.purpose,
            tenantId: c.tenantId,
            filename: c.filename,
            contentType: c.contentType,
            uploadKeyHash: deriveUploadKeyHash({
              uploadKey: c.uploadKey,
              tenantId: c.tenantId,
              purpose: c.purpose,
              actorUid: c.actorUid,
            }),
            now: c.now,
            randomSuffix: c.randomSuffix,
            ...c.inputs,
          });

          expect(resolved.ok).toBe(true);
          if (!resolved.ok) return;

          // Charset + non-emptiness of the reported segments…
          expect(resolved.safeExt).toMatch(SAFE_SEGMENT_RE);
          expect(resolved.safeName).toMatch(SAFE_SEGMENT_RE);
          // …and of every segment actually written to the path below the tenant.
          for (const segment of resolved.objectPath.split('/').slice(2)) {
            expect(segment).toMatch(SAFE_SEGMENT_RE);
          }

          // Extension inference is total: mapped content type, else the trailing
          // dot-part of the sanitized filename, else `bin`.
          const sanitizedFilename = oracleSanitize(c.filename || 'file');
          const extFallback = sanitizedFilename.split('.').pop() || 'bin';
          const expectedExt = oracleSanitize(oracleExt(c.contentType, extFallback)) || 'bin';
          expect(resolved.safeExt).toBe(expectedExt);

          // Filename fallback: `file`/`receipt` when the client value sanitizes away.
          if (!sanitizedFilename) {
            expect(resolved.safeName).toBe(
              c.purpose === 'receipt' ? `receipt.${expectedExt}` : `file.${expectedExt}`
            );
          } else {
            expect(resolved.safeName).toBe(sanitizedFilename);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
