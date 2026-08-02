/**
 * Feature: upload-idempotency — task 2.1 golden example tests.
 *
 * THIS FILE IS THE BACKWARD-COMPATIBILITY REGRESSION NET for task 3.1 (rewiring
 * `POST /storage/upload` onto this module). Every `objectPath` literal below was
 * derived from the derivation block that lives in `app.ts` **today** (the route at
 * `app.ts:13938`, path assembly at `app.ts:14128`-`app.ts:14165`), by transcribing
 * that block verbatim with `Date.now()` and `crypto.randomBytes(3).toString('hex')`
 * replaced by the injected `NOW` / `RANDOM_SUFFIX` values used here — NOT by reading
 * the new module's output back. If a change to `resolveUploadObjectPath` breaks one of
 * these, the deployed clients' paths moved, and that is a bug in the change rather
 * than a stale expectation.
 *
 * Pure jest: no Express app, no Firebase Admin, no bucket, no network.
 *
 * _Requirements: 1.5, 1.6, 2.1, 10.3, 10.4_
 */
import {
  computeUploadQuotaDelta,
  deriveUploadKeyHash,
  hashStorageKey,
  inferExtensionFromContentType,
  normalizeConversationFolder,
  resolveUploadObjectPath,
  type ResolveUploadObjectPathArgs,
  type StorageUploadPurpose,
} from '../lib/uploadObjectPath';

// ---------------------------------------------------------------------------
// Shared golden inputs. `NOW` and `RANDOM_SUFFIX` stand in for the route's
// `Date.now()` and `crypto.randomBytes(3).toString('hex')`.
// ---------------------------------------------------------------------------
const TENANT = 'acme';
const NOW = 1_700_000_000_000;
const RANDOM_SUFFIX = 'aabbcc';
const FILENAME = 'march.pdf';
const CONTENT_TYPE = 'application/pdf';
const FEE_ID = 'fee_77';
const CONVERSATION_FOLDER = 'conv1';
const EMAIL = 'a@b.com';

/**
 * A fixed 20-lowercase-hex stand-in for a `deriveUploadKeyHash()` result, so the
 * deterministic goldens below are readable literals. The real derivation is pinned
 * separately in the `deriveUploadKeyHash` suite (it mixes the purpose into the hash,
 * so a real derivation would produce a different value per purpose and make these
 * seven goldens unreadable).
 */
const KEY_HASH = 'ab732452ef4d2f31f036';

/** `hashStorageKey('conv1')` — the conversation folder today's route derives. */
const CONV_FOLDER_HASH = 'c_4ae47b2b94176a5dbcf5';
/** `hashStorageKey('a_b.com')` — `a@b.com` sanitized, then hashed, as today. */
const EMAIL_HASH = '7a7ce06021dfad4a95ca';

function args(overrides: Partial<ResolveUploadObjectPathArgs> = {}): ResolveUploadObjectPathArgs {
  return {
    purpose: 'chat',
    tenantId: TENANT,
    filename: FILENAME,
    contentType: CONTENT_TYPE,
    conversationFolder: CONVERSATION_FOLDER,
    feeId: FEE_ID,
    email: EMAIL,
    uploadKeyHash: null,
    now: NOW,
    randomSuffix: RANDOM_SUFFIX,
    ...overrides,
  };
}

/** Narrowing helper so the `ok: false` branch fails loudly instead of type-erroring. */
function expectOk(result: ReturnType<typeof resolveUploadObjectPath>) {
  if (!result.ok) {
    throw new Error(`expected ok result, got error "${result.error}"`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Legacy paths — the regression net (Req 2.1, 10.4)
// ---------------------------------------------------------------------------
describe('resolveUploadObjectPath — golden LEGACY paths (no uploadKey)', () => {
  const cases: Array<[StorageUploadPurpose, string]> = [
    ['chat', `chat-files/acme/${CONV_FOLDER_HASH}/1700000000000_march.pdf`],
    ['tenantLogo', 'tenant-branding/acme/logo_1700000000000.pdf'],
    ['noticeImage', 'notices/acme/notice_1700000000000_aabbcc.pdf'],
    ['noticeAudio', 'notices/acme/audio/notice_audio_1700000000000_aabbcc.pdf'],
    ['studentProfile', 'student_profiles/acme/1700000000000_profile.pdf'],
    ['receipt', 'receipts/acme/fee_77/1700000000000_march.pdf'],
    // profilePicture has always been deterministic — this IS its legacy format.
    ['profilePicture', `profile-pictures/acme/${EMAIL_HASH}.jpg`],
  ];

  it.each(cases)('%s resolves character-for-character to today\'s path', (purpose, expected) => {
    const result = expectOk(resolveUploadObjectPath(args({ purpose, uploadKeyHash: null })));
    expect(result.objectPath).toBe(expected);
  });

  it('flags every purpose except profilePicture as non-deterministic', () => {
    for (const [purpose] of cases) {
      const result = expectOk(resolveUploadObjectPath(args({ purpose, uploadKeyHash: null })));
      expect(result.deterministic).toBe(purpose === 'profilePicture');
    }
  });

  it('reports the sanitized extension and name alongside the path', () => {
    const result = expectOk(resolveUploadObjectPath(args({ purpose: 'receipt' })));
    expect(result.safeExt).toBe('pdf');
    expect(result.safeName).toBe('march.pdf');
  });
});

// ---------------------------------------------------------------------------
// Deterministic paths (Req 1.3, 10.4)
// ---------------------------------------------------------------------------
describe('resolveUploadObjectPath — golden DETERMINISTIC paths (uploadKey present)', () => {
  const cases: Array<[StorageUploadPurpose, string]> = [
    ['chat', `chat-files/acme/${CONV_FOLDER_HASH}/k_${KEY_HASH}_march.pdf`],
    ['tenantLogo', `tenant-branding/acme/logo_k_${KEY_HASH}.pdf`],
    ['noticeImage', `notices/acme/notice_k_${KEY_HASH}.pdf`],
    ['noticeAudio', `notices/acme/audio/notice_audio_k_${KEY_HASH}.pdf`],
    ['studentProfile', `student_profiles/acme/k_${KEY_HASH}_profile.pdf`],
    ['receipt', `receipts/acme/fee_77/k_${KEY_HASH}_march.pdf`],
    // profilePicture ignores the key: one stable object per user, keyed on email.
    ['profilePicture', `profile-pictures/acme/${EMAIL_HASH}.jpg`],
  ];

  it.each(cases)('%s places the k_-marked key hash in the variable segment', (purpose, expected) => {
    const result = expectOk(resolveUploadObjectPath(args({ purpose, uploadKeyHash: KEY_HASH })));
    expect(result.objectPath).toBe(expected);
    expect(result.deterministic).toBe(true);
  });

  it('keeps the legacy and deterministic namespaces disjoint', () => {
    for (const [purpose] of cases) {
      if (purpose === 'profilePicture') continue;
      const legacy = expectOk(resolveUploadObjectPath(args({ purpose, uploadKeyHash: null })));
      const keyed = expectOk(resolveUploadObjectPath(args({ purpose, uploadKeyHash: KEY_HASH })));
      expect(keyed.objectPath).not.toBe(legacy.objectPath);
    }
  });
});

// ---------------------------------------------------------------------------
// profilePicture special case (Req 1.5)
// ---------------------------------------------------------------------------
describe('resolveUploadObjectPath — profilePicture accepts an uploadKey and ignores it', () => {
  it('resolves profile-pictures/{tenantId}/{hash(email)}.jpg with or without a key', () => {
    const withoutKey = expectOk(
      resolveUploadObjectPath(args({ purpose: 'profilePicture', uploadKeyHash: null }))
    );
    const withKey = expectOk(
      resolveUploadObjectPath(args({ purpose: 'profilePicture', uploadKeyHash: KEY_HASH }))
    );
    expect(withoutKey.objectPath).toBe(`profile-pictures/acme/${EMAIL_HASH}.jpg`);
    expect(withKey.objectPath).toBe(withoutKey.objectPath);
    expect(withKey.deterministic).toBe(true);
  });

  it('normalizes case and whitespace in the email exactly as today', () => {
    const result = expectOk(
      resolveUploadObjectPath(args({ purpose: 'profilePicture', email: '  A@B.CoM  ' }))
    );
    expect(result.objectPath).toBe(`profile-pictures/acme/${EMAIL_HASH}.jpg`);
  });

  it('does not let now or randomSuffix leak into the path', () => {
    const first = expectOk(resolveUploadObjectPath(args({ purpose: 'profilePicture' })));
    const second = expectOk(
      resolveUploadObjectPath(
        args({ purpose: 'profilePicture', now: 1, randomSuffix: 'ffeedd' })
      )
    );
    expect(second.objectPath).toBe(first.objectPath);
  });
});

// ---------------------------------------------------------------------------
// Failure results (Req 1.6)
// ---------------------------------------------------------------------------
describe('resolveUploadObjectPath — failure results', () => {
  it.each([['empty', ''], ['whitespace only', '   '], ['undefined', undefined]])(
    'returns missing_email for a %s email on profilePicture',
    (_label, email) => {
      const result = resolveUploadObjectPath(
        args({ purpose: 'profilePicture', email: email as string | undefined })
      );
      expect(result).toEqual({ ok: false, error: 'missing_email' });
    }
  );

  it('returns invalid_upload_purpose for an unmapped purpose', () => {
    const result = resolveUploadObjectPath(
      args({ purpose: 'somethingElse' as unknown as StorageUploadPurpose })
    );
    expect(result).toEqual({ ok: false, error: 'invalid_upload_purpose' });
  });
});

// ---------------------------------------------------------------------------
// The ONE intentional legacy divergence introduced by task 1.1
// ---------------------------------------------------------------------------
describe('resolveUploadObjectPath — intentional divergence: dot-only feeId', () => {
  /**
   * WHY THIS DEVIATES FROM TODAY'S app.ts:
   *
   * Today's route computes the receipt folder as
   *   `sanitizeStorageSegment(parsed.data.feeId || 'unknown') || 'unknown'`
   * and `sanitizeStorageSegment` keeps `.` (its allowed set is `[A-Za-z0-9._-]`).
   * A `feeId` of exactly `.` or `..` therefore survives sanitization intact and is
   * emitted as a literal relative-path segment:
   *   feeId '.'  -> receipts/acme/./1700000000000_march.pdf
   *   feeId '..' -> receipts/acme/../1700000000000_march.pdf
   * The `..` case escapes the `receipts/{tenantId}/` prefix once normalized, which
   * violates Requirement 6.5 ("SHALL contain no `..` segment, no empty segment and no
   * leading slash") and would slip past the `/storage/delete` and
   * `/video/request-transcode` prefix authorizations.
   *
   * `sanitizeWholeSegment` in the extracted module therefore falls back to `unknown`
   * for those two exact inputs. This is a deliberate, security-motivated divergence
   * from today's behavior, not an accident of the relocation — it is the only input
   * for which the new module's path differs from the current route's.
   */
  it.each(['.', '..'])('falls back to the "unknown" folder for feeId %j (today: a literal dot segment)', (feeId) => {
    const result = expectOk(resolveUploadObjectPath(args({ purpose: 'receipt', feeId })));
    expect(result.objectPath).toBe('receipts/acme/unknown/1700000000000_march.pdf');
    // Confinement, stated directly: no segment is a relative-path segment.
    expect(result.objectPath.split('/')).not.toContain('..');
    expect(result.objectPath.split('/')).not.toContain('.');
    expect(result.objectPath.startsWith(`receipts/${TENANT}/`)).toBe(true);
  });

  it('keeps every other dot-containing feeId byte-identical to today', () => {
    // Narrow guard: only the exact values `.` and `..` divert. `...`, `..v2` and a
    // blank value all behave exactly as the current route does.
    expect(expectOk(resolveUploadObjectPath(args({ purpose: 'receipt', feeId: '...' }))).objectPath).toBe(
      'receipts/acme/.../1700000000000_march.pdf'
    );
    expect(
      expectOk(resolveUploadObjectPath(args({ purpose: 'receipt', feeId: 'fee..77' }))).objectPath
    ).toBe('receipts/acme/fee..77/1700000000000_march.pdf');
    expect(expectOk(resolveUploadObjectPath(args({ purpose: 'receipt', feeId: '' }))).objectPath).toBe(
      'receipts/acme/unknown/1700000000000_march.pdf'
    );
    expect(
      expectOk(resolveUploadObjectPath(args({ purpose: 'receipt', feeId: 'fee/77' }))).objectPath
    ).toBe('receipts/acme/fee_77/1700000000000_march.pdf');
  });
});

// ---------------------------------------------------------------------------
// deriveUploadKeyHash — shape and scope separation (Req 6.1, 6.2, 6.3)
// ---------------------------------------------------------------------------
describe('deriveUploadKeyHash', () => {
  const base = {
    uploadKey: 'upload-key-golden-1',
    tenantId: TENANT,
    purpose: 'receipt' as StorageUploadPurpose,
    actorUid: 'uid_staff_1',
  };

  it('returns 20 lowercase hex chars and nothing from the raw key', () => {
    const hash = deriveUploadKeyHash(base);
    expect(hash).toBe('00dd030d6ea4a934da01');
    expect(hash).toMatch(/^[0-9a-f]{20}$/);
    expect(hash).not.toContain('upload-key');
  });

  it('returns null for an absent or blank key (⇒ legacy path)', () => {
    expect(deriveUploadKeyHash({ ...base, uploadKey: undefined })).toBeNull();
    expect(deriveUploadKeyHash({ ...base, uploadKey: null })).toBeNull();
    expect(deriveUploadKeyHash({ ...base, uploadKey: '   ' })).toBeNull();
  });

  it('separates scope by tenant, purpose and actor', () => {
    const hash = deriveUploadKeyHash(base);
    expect(deriveUploadKeyHash({ ...base, tenantId: 'globex' })).not.toBe(hash);
    expect(deriveUploadKeyHash({ ...base, purpose: 'chat' })).not.toBe(hash);
    expect(deriveUploadKeyHash({ ...base, actorUid: 'uid_staff_2' })).not.toBe(hash);
  });

  it('feeds a real derived hash into a real deterministic path', () => {
    const hash = deriveUploadKeyHash(base);
    const result = expectOk(
      resolveUploadObjectPath(args({ purpose: 'receipt', uploadKeyHash: hash }))
    );
    expect(result.objectPath).toBe('receipts/acme/fee_77/k_00dd030d6ea4a934da01_march.pdf');
  });
});

// ---------------------------------------------------------------------------
// Relocated helpers still behave as they did in app.ts (Req 10.3)
// ---------------------------------------------------------------------------
describe('inferExtensionFromContentType — fallbacks preserved after the relocation', () => {
  it('maps the content types today\'s route maps', () => {
    expect(inferExtensionFromContentType('image/png')).toBe('png');
    expect(inferExtensionFromContentType('image/jpeg')).toBe('jpg');
    expect(inferExtensionFromContentType('image/jpg')).toBe('jpg');
    expect(inferExtensionFromContentType('image/webp')).toBe('webp');
    expect(inferExtensionFromContentType('image/svg+xml')).toBe('svg');
    expect(inferExtensionFromContentType('audio/mpeg')).toBe('mp3');
    expect(inferExtensionFromContentType('audio/mp3')).toBe('mp3');
    expect(inferExtensionFromContentType('audio/wav')).toBe('wav');
    expect(inferExtensionFromContentType('audio/ogg')).toBe('ogg');
    expect(inferExtensionFromContentType('audio/mp4')).toBe('m4a');
    expect(inferExtensionFromContentType('audio/m4a')).toBe('m4a');
    expect(inferExtensionFromContentType('application/pdf')).toBe('pdf');
  });

  it('trims and lowercases before matching', () => {
    expect(inferExtensionFromContentType('  IMAGE/JPEG ')).toBe('jpg');
  });

  it('falls back to "bin" by default and to the caller\'s fallback when given one', () => {
    expect(inferExtensionFromContentType('application/octet-stream')).toBe('bin');
    expect(inferExtensionFromContentType(undefined)).toBe('bin');
    expect(inferExtensionFromContentType(null)).toBe('bin');
    expect(inferExtensionFromContentType('')).toBe('bin');
    expect(inferExtensionFromContentType('application/octet-stream', 'gz')).toBe('gz');
    expect(inferExtensionFromContentType(null, 'zip')).toBe('zip');
  });

  it('uses the filename extension as the fallback, as the route does', () => {
    // Route order: filename -> extFallback (last dot segment) -> content-type lookup.
    const result = expectOk(
      resolveUploadObjectPath(
        args({
          purpose: 'tenantLogo',
          filename: 'archive.tar.gz',
          contentType: 'application/octet-stream',
        })
      )
    );
    expect(result.objectPath).toBe('tenant-branding/acme/logo_1700000000000.gz');
  });

  it('uses the whole filename as the fallback when it has no dot, as the route does', () => {
    // `'noext'.split('.').pop()` is `'noext'`, so an unmapped content type yields
    // `.noext`. Odd-looking, but it is exactly today's behavior and must not change.
    const result = expectOk(
      resolveUploadObjectPath(
        args({ purpose: 'tenantLogo', filename: 'noext', contentType: 'application/zip' })
      )
    );
    expect(result.objectPath).toBe('tenant-branding/acme/logo_1700000000000.noext');
  });
});

describe('normalizeConversationFolder — behavior preserved after the relocation', () => {
  it('keeps an existing c_… folder of at least 10 chars untouched', () => {
    expect(normalizeConversationFolder('c_1234567890abc')).toBe('c_1234567890abc');
  });

  it('hashes anything else, including a too-short c_ value', () => {
    expect(normalizeConversationFolder('conv1')).toBe(`c_${hashStorageKey('conv1')}`);
    expect(normalizeConversationFolder('conv1')).toBe(CONV_FOLDER_HASH);
    expect(normalizeConversationFolder('c_short')).toBe(`c_${hashStorageKey('c_short')}`);
    expect(normalizeConversationFolder('thread_42')).toBe(`c_${hashStorageKey('thread_42')}`);
  });

  it('returns "unassigned" for a blank value', () => {
    expect(normalizeConversationFolder('')).toBe('unassigned');
    expect(normalizeConversationFolder('   ')).toBe('unassigned');
  });

  it('is applied to the chat path exactly as the route applies it', () => {
    const preHashed = expectOk(
      resolveUploadObjectPath(args({ purpose: 'chat', conversationFolder: 'c_1234567890abc' }))
    );
    expect(preHashed.objectPath).toBe(
      'chat-files/acme/c_1234567890abc/1700000000000_march.pdf'
    );

    // A blank folder becomes 'unassigned' at the route boundary, which
    // normalizeConversationFolder then hashes — matching today's two-step behavior.
    const blank = expectOk(resolveUploadObjectPath(args({ purpose: 'chat', conversationFolder: '' })));
    expect(blank.objectPath).toBe(
      `chat-files/acme/c_${hashStorageKey('unassigned')}/1700000000000_march.pdf`
    );
  });
});

// ---------------------------------------------------------------------------
// computeUploadQuotaDelta boundaries (Req 3.2, 3.3, 10.4)
// ---------------------------------------------------------------------------
describe('computeUploadQuotaDelta — boundaries', () => {
  it('existingBytes 0 reproduces today\'s full-file reservation', () => {
    expect(computeUploadQuotaDelta({ newBytes: 1000, existingBytes: 0 })).toEqual({
      reserveBytes: 1000,
      shrinkBytes: 0,
      isOverwrite: false,
    });
  });

  it('equal sizes reserve and release nothing but count as an overwrite', () => {
    expect(computeUploadQuotaDelta({ newBytes: 1000, existingBytes: 1000 })).toEqual({
      reserveBytes: 0,
      shrinkBytes: 0,
      isOverwrite: true,
    });
  });

  it('an existing object one byte smaller reserves exactly one byte', () => {
    expect(computeUploadQuotaDelta({ newBytes: 1000, existingBytes: 999 })).toEqual({
      reserveBytes: 1,
      shrinkBytes: 0,
      isOverwrite: true,
    });
  });

  it('an existing object one byte larger shrinks by exactly one byte', () => {
    expect(computeUploadQuotaDelta({ newBytes: 1000, existingBytes: 1001 })).toEqual({
      reserveBytes: 0,
      shrinkBytes: 1,
      isOverwrite: true,
    });
  });
});
