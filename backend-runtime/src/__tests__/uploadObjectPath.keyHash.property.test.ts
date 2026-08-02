// Feature: upload-idempotency, Property 5: Upload-key hashing is scope-separated and leak-free — for any uploadKey the derived hash matches /^[0-9a-f]{20}$/, and for any two derivations differing in exactly one of tenantId, purpose or actorUid the derived hashes differ.
/**
 * Property-based tests for `deriveUploadKeyHash` in the pure module
 * `src/lib/uploadObjectPath.ts` (upload-idempotency, design Property 5).
 *
 * These drive the real exported function — no Express, no Firebase, no mocking.
 * Every property runs at least 100 fast-check iterations.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3**
 *
 * What is asserted, and why each direction matters:
 *
 * 1. **Shape** (Req 6.1) — exactly 20 lowercase hex characters. This is the only
 *    `uploadKey`-derived content that ever reaches an object path, so if the shape
 *    ever widened, arbitrary client bytes would start reaching Storage keys.
 * 2. **Scope separation** (Req 6.2) — changing exactly one of `tenantId`,
 *    `purpose` or `actorUid` while holding the raw key fixed changes the hash.
 *    Asserted in three separate directions because each is a distinct security
 *    claim: tenant separation makes cross-tenant overwrite impossible, actor
 *    separation makes one staff member overwriting another's object impossible
 *    (even inside one tenant, even knowing their key), and purpose separation
 *    keeps a receipt key from colliding with a notice key.
 * 3. **Determinism** (Req 1.1 via 6.1) — the same tuple always yields the same
 *    hash. Without this the whole retry-stability feature collapses.
 * 4. **Leak-freedom** (Req 6.3) — no meaningful run of the raw key survives into
 *    the hash. See the coincidence-threshold note above the leak property.
 * 5. **Blank handling / trimming** — absent or blank-after-trim keys derive
 *    `null` (⇒ legacy timestamped path), and a key padded with surrounding
 *    whitespace derives the SAME hash as its trimmed form, matching the
 *    endpoint's `z.string().trim()` schema.
 * 6. **Anti-spoofing** — the implementation NUL-joins
 *    `[domain, tenantId, purpose, actorUid, trimmedKey]` with the untrusted value
 *    LAST. A key crafted to look like it embeds another tenant's scope fields
 *    therefore cannot collide with that tenant's genuine derivation, because the
 *    scope fields occupy fixed leading positions the client cannot reach.
 *
 * Generator note on `tenantId` / `actorUid`: these are server-derived
 * (`req.tenantAccess.tenantId`, `req.authContext.uid`, Req 6.6), so the
 * generators produce realistic guard-resolved shapes — non-empty, NUL-free — of
 * varying length and character class. `null`/`undefined` scope values are
 * deliberately excluded from the distinctness generators: the implementation
 * coalesces them to `''` (`args.tenantId ?? ''`), so "absent tenant" and "empty
 * tenant" are the same scope by construction, and asserting they differ would be
 * asserting something the code does not claim.
 */

import * as fc from 'fast-check';

import { deriveUploadKeyHash, type StorageUploadPurpose } from '../lib/uploadObjectPath';

const NUM_RUNS = 200;

const HASH_RE = /^[0-9a-f]{20}$/;

const ALL_PURPOSES: readonly StorageUploadPurpose[] = [
  'chat',
  'tenantLogo',
  'noticeImage',
  'noticeAudio',
  'studentProfile',
  'receipt',
  'profilePicture',
];

/** Domain separator constant mirrored from the module under test. */
const UPLOAD_KEY_HASH_DOMAIN = 'upload-key-v1';
/** The field separator the module joins its hash material with. */
const NUL = '\u0000';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const purposeArb = fc.constantFrom(...ALL_PURPOSES);

/**
 * Server-derived tenant ids of varying shapes: single character, long,
 * dot/dash/underscore bearing, all-digit, non-ASCII. All distinct as strings,
 * all non-empty, none containing NUL.
 */
const TENANT_IDS = [
  'a',
  'acme',
  'tenant_1',
  'T-42',
  'tenant.with.dots',
  '0123456789',
  'abcdefghijklmnopqrstuvwxyz0123456789',
  'テナント',
  'tenant-日本-01',
  'T'.repeat(120),
] as const;

/** Server-derived actor uids of varying shapes (Firebase uids are 28 chars; also cover odd ones). */
const ACTOR_UIDS = [
  'u',
  'uid_123',
  'UID-abc',
  'AbCdEf0123456789AbCdEf0123',
  '0000000000000000000000000000',
  'staff-9',
  'x'.repeat(200),
  'actor.with.dots',
  'アクター',
] as const;

const tenantIdArb = fc.constantFrom(...TENANT_IDS);
const actorUidArb = fc.constantFrom(...ACTOR_UIDS);

/**
 * Awkward-but-non-blank raw upload keys: whitespace-padded, non-ASCII, very
 * long, containing the module's own domain separator string, containing NUL,
 * containing tenant-id-looking fragments, plus arbitrary Unicode.
 */
const AWKWARD_KEYS = [
  'a'.repeat(8),
  '4f8d1c2e-9a3b-4c5d-8e7f-0a1b2c3d4e5f',
  'receipt_1717171717171_abc123',
  '  padded-upload-key-0001  ',
  '\t\n leading-and-trailing \r\n',
  '\u00a0nbsp-padded-key-0001\u00a0',
  '\ufeffbom-padded-key-0001\ufeff',
  'ключ-загрузки-0001',
  '鍵アップロード0001',
  'emoji-key-🎉-0001',
  'k'.repeat(200),
  'z'.repeat(5000),
  `${UPLOAD_KEY_HASH_DOMAIN}${NUL}acme${NUL}receipt${NUL}uid_123`,
  `key${NUL}with${NUL}nuls`,
  `${NUL}${NUL}${NUL}leading-nuls`,
  'acme\u0000chat\u0000uid_123\u0000inner-key',
  'upload-key-v1',
  'deadbeefdeadbeefdead',
  '0123456789abcdef0123',
  '../../etc/passwd-key',
  'k_0123456789abcdef0123',
] as const;

const nonBlankKeyArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 6, arbitrary: fc.constantFrom(...AWKWARD_KEYS) },
    { weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 60 }) },
    { weight: 2, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }) },
    { weight: 1, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 40 }) },
  )
  .filter((k) => k.trim().length > 0);

/** Absent / blank-after-trim keys: every one of these must derive `null`. */
const blankKeyArb: fc.Arbitrary<string | null | undefined> = fc.constantFrom(
  undefined,
  null,
  '',
  ' ',
  '     ',
  '\t',
  '\n',
  '\r\n',
  '\t \n \r ',
  '\u000b\u000c',
  '\u00a0', // NBSP
  '\u2028\u2029', // LINE / PARAGRAPH SEPARATOR
  '\u3000', // IDEOGRAPHIC SPACE
  '\ufeff', // BOM
  '\u00a0\ufeff \t\n',
);

/** Whitespace runs that `String.prototype.trim()` removes. */
const paddingArb = fc.constantFrom('', ' ', '   ', '\t', '\n', '\r\n', '\u00a0', '\u3000', '\ufeff', '\t \u00a0\n');

/** A key whose own edges carry no whitespace, so padding it is a pure prefix/suffix change. */
const unpaddedKeyArb: fc.Arbitrary<string> = nonBlankKeyArb.map((k) => k.trim()).filter((k) => k.length > 0);

interface Scope {
  tenantId: string;
  purpose: StorageUploadPurpose;
  actorUid: string;
}

const scopeArb: fc.Arbitrary<Scope> = fc.record({
  tenantId: tenantIdArb,
  purpose: purposeArb,
  actorUid: actorUidArb,
});

/** Two distinct values drawn from the same pool, without filter-heavy retries. */
function distinctPairArb<T>(pool: readonly T[]): fc.Arbitrary<[T, T]> {
  return fc
    .tuple(fc.integer({ min: 0, max: pool.length - 1 }), fc.integer({ min: 1, max: pool.length - 1 }))
    .map(([i, offset]) => [pool[i], pool[(i + offset) % pool.length]] as [T, T]);
}

// ---------------------------------------------------------------------------
// Leak-freedom threshold
// ---------------------------------------------------------------------------
/**
 * Minimum raw-key substring length treated as evidence of a leak.
 *
 * The hash is 20 lowercase hex characters, so only substrings of the raw key that
 * are themselves lowercase hex can ever appear inside it. For a hex substring of
 * length L the probability of a purely coincidental appearance is at most
 * `(21 - L) * 16^-L`: ~2.6e-4 at L = 4 (which, over hundreds of runs against long
 * hex-ish keys, would make this suite genuinely flaky on CORRECT code) but ~3e-9
 * at L = 8. Eight is also the endpoint's minimum accepted key length
 * (`z.string().trim().min(8)`, Req 6.8), so it is exactly the shortest key the
 * feature ever hashes in production.
 *
 * Checking substrings of exactly this length is sufficient for all longer ones:
 * if the hash contained a 12-character run of the key it would necessarily also
 * contain that run's first 8 characters.
 */
const MIN_LEAK_SUBSTRING = 8;

/** Every substring of `value` of exactly `length` characters. */
function substringsOfLength(value: string, length: number): string[] {
  if (value.length < length) return [];
  const out: string[] = [];
  for (let i = 0; i + length <= value.length; i += 1) out.push(value.slice(i, i + length));
  return out;
}

// ---------------------------------------------------------------------------

describe('Property 5: Upload-key hashing is scope-separated and leak-free', () => {
  describe('hash shape (Requirement 6.1)', () => {
    it('derives exactly 20 lowercase hex characters for any non-blank key and any scope', () => {
      fc.assert(
        fc.property(nonBlankKeyArb, scopeArb, (uploadKey, scope) => {
          const hash = deriveUploadKeyHash({ uploadKey, ...scope });
          expect(hash).not.toBeNull();
          expect(hash).toMatch(HASH_RE);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('scope separation (Requirement 6.2)', () => {
    it('produces different hashes when only the tenantId differs — no cross-tenant overwrite', () => {
      fc.assert(
        fc.property(
          nonBlankKeyArb,
          distinctPairArb(TENANT_IDS),
          purposeArb,
          actorUidArb,
          (uploadKey, [tenantA, tenantB], purpose, actorUid) => {
            expect(tenantA).not.toBe(tenantB);
            const a = deriveUploadKeyHash({ uploadKey, tenantId: tenantA, purpose, actorUid });
            const b = deriveUploadKeyHash({ uploadKey, tenantId: tenantB, purpose, actorUid });
            expect(a).toMatch(HASH_RE);
            expect(b).toMatch(HASH_RE);
            expect(a).not.toBe(b);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('produces different hashes when only the purpose differs', () => {
      fc.assert(
        fc.property(
          nonBlankKeyArb,
          tenantIdArb,
          distinctPairArb(ALL_PURPOSES),
          actorUidArb,
          (uploadKey, tenantId, [purposeA, purposeB], actorUid) => {
            expect(purposeA).not.toBe(purposeB);
            const a = deriveUploadKeyHash({ uploadKey, tenantId, purpose: purposeA, actorUid });
            const b = deriveUploadKeyHash({ uploadKey, tenantId, purpose: purposeB, actorUid });
            expect(a).toMatch(HASH_RE);
            expect(b).toMatch(HASH_RE);
            expect(a).not.toBe(b);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('produces different hashes when only the actorUid differs — no cross-actor overwrite inside a tenant', () => {
      fc.assert(
        fc.property(
          nonBlankKeyArb,
          tenantIdArb,
          purposeArb,
          distinctPairArb(ACTOR_UIDS),
          (uploadKey, tenantId, purpose, [actorA, actorB]) => {
            expect(actorA).not.toBe(actorB);
            const a = deriveUploadKeyHash({ uploadKey, tenantId, purpose, actorUid: actorA });
            const b = deriveUploadKeyHash({ uploadKey, tenantId, purpose, actorUid: actorB });
            expect(a).toMatch(HASH_RE);
            expect(b).toMatch(HASH_RE);
            expect(a).not.toBe(b);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('produces different hashes for distinct keys within one scope', () => {
      // The complement of scope separation: one scope must still discriminate keys,
      // otherwise two unrelated uploads by the same actor would overwrite each other.
      fc.assert(
        fc.property(nonBlankKeyArb, nonBlankKeyArb, scopeArb, (keyA, keyB, scope) => {
          fc.pre(keyA.trim() !== keyB.trim());
          const a = deriveUploadKeyHash({ uploadKey: keyA, ...scope });
          const b = deriveUploadKeyHash({ uploadKey: keyB, ...scope });
          expect(a).not.toBe(b);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('determinism', () => {
    it('yields the identical hash for identical (uploadKey, tenantId, purpose, actorUid)', () => {
      fc.assert(
        fc.property(nonBlankKeyArb, scopeArb, (uploadKey, scope) => {
          const first = deriveUploadKeyHash({ uploadKey, ...scope });
          const second = deriveUploadKeyHash({ uploadKey, ...scope });
          // Fresh argument objects, and a re-created key string, so nothing can be
          // memoized on object identity.
          const third = deriveUploadKeyHash({
            uploadKey: `${uploadKey}`,
            tenantId: `${scope.tenantId}`,
            purpose: scope.purpose,
            actorUid: `${scope.actorUid}`,
          });
          expect(second).toBe(first);
          expect(third).toBe(first);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('leak-freedom (Requirement 6.3)', () => {
    it('never lets a meaningful run of the raw key survive into the hash', () => {
      fc.assert(
        fc.property(nonBlankKeyArb, scopeArb, (uploadKey, scope) => {
          const hash = deriveUploadKeyHash({ uploadKey, ...scope });
          expect(hash).toMatch(HASH_RE);
          const trimmed = uploadKey.trim();

          // A digest is never the key itself, at any length.
          expect(hash).not.toBe(trimmed);
          expect(hash).not.toBe(uploadKey);

          // The whole key never appears inside the hash — asserted only for keys at
          // or above the coincidence threshold. A degenerate short key is genuinely
          // expected to turn up by chance: `uploadKey: 'a'` appears in a random
          // 20-hex-character digest with probability 1 - (15/16)^20 ≈ 72%, which is
          // a property of hex digests, not a leak. (This exact counterexample was
          // produced by an earlier, unguarded version of this assertion.) The
          // endpoint rejects keys under 8 characters anyway (Req 6.8), so nothing
          // the feature hashes in production is skipped here.
          if (trimmed.length >= MIN_LEAK_SUBSTRING) {
            expect(hash!.includes(trimmed)).toBe(false);
          }
          if (uploadKey.length >= MIN_LEAK_SUBSTRING) {
            expect(hash!.includes(uploadKey)).toBe(false);
          }

          // And no `MIN_LEAK_SUBSTRING`-character run of the key appears either —
          // the same threshold, for the same reason (see the note above it).
          const candidates = substringsOfLength(trimmed.slice(0, 512), MIN_LEAK_SUBSTRING);
          for (const candidate of candidates) {
            expect(hash!.includes(candidate)).toBe(false);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('absent keys and trimming', () => {
    it('returns null for an absent or blank-after-trim key', () => {
      fc.assert(
        fc.property(blankKeyArb, scopeArb, (uploadKey, scope) => {
          expect(deriveUploadKeyHash({ uploadKey, ...scope })).toBeNull();
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('derives the same hash for a key and the same key with surrounding whitespace', () => {
      // The endpoint's zod schema trims too (`z.string().trim()`), so a transport
      // that pads the value on one attempt must still hit the same object.
      fc.assert(
        fc.property(unpaddedKeyArb, paddingArb, paddingArb, scopeArb, (key, left, right, scope) => {
          const bare = deriveUploadKeyHash({ uploadKey: key, ...scope });
          const padded = deriveUploadKeyHash({ uploadKey: `${left}${key}${right}`, ...scope });
          expect(bare).toMatch(HASH_RE);
          expect(padded).toBe(bare);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('scope fields cannot be spoofed by a crafted key (Requirements 6.2, 6.3)', () => {
    it('a key embedding another tenant/actor scope cannot collide with that tenant/actor genuine derivation', () => {
      // The module joins `[domain, tenantId, purpose, actorUid, trimmedKey]` with
      // NUL and the untrusted value is LAST, so the four leading positions are
      // beyond client reach. An attacker in tenant A therefore cannot reproduce
      // tenant B's hash by stuffing B's scope into the key, however the key is
      // shaped. A genuine collision here would be a real cross-tenant overwrite
      // primitive, not a test defect.
      fc.assert(
        fc.property(
          distinctPairArb(TENANT_IDS),
          distinctPairArb(ACTOR_UIDS),
          purposeArb,
          purposeArb,
          unpaddedKeyArb,
          fc.integer({ min: 0, max: 7 }),
          ([attackerTenant, victimTenant], [attackerUid, victimUid], attackerPurpose, victimPurpose, victimKey, shape) => {
            const victimHash = deriveUploadKeyHash({
              uploadKey: victimKey,
              tenantId: victimTenant,
              purpose: victimPurpose,
              actorUid: victimUid,
            });
            expect(victimHash).toMatch(HASH_RE);

            // Eight shapes of crafted key, each an attempt to forge the scope
            // prefix the implementation controls.
            const craftedKeys = [
              `${victimTenant}${NUL}${victimPurpose}${NUL}${victimUid}${NUL}${victimKey}`,
              `${NUL}${victimTenant}${NUL}${victimPurpose}${NUL}${victimUid}${NUL}${victimKey}`,
              `${UPLOAD_KEY_HASH_DOMAIN}${NUL}${victimTenant}${NUL}${victimPurpose}${NUL}${victimUid}${NUL}${victimKey}`,
              `${victimKey}${NUL}${victimTenant}`,
              `${victimTenant}${NUL}${victimKey}`,
              `${victimUid}${NUL}${victimKey}`,
              `${victimPurpose}${NUL}${victimKey}`,
              `${NUL.repeat(4)}${victimTenant}${victimPurpose}${victimUid}${victimKey}`,
            ];
            const crafted = craftedKeys[shape % craftedKeys.length];

            // The attacker's own scope: their tenant, their uid, any purpose.
            const attackerHash = deriveUploadKeyHash({
              uploadKey: crafted,
              tenantId: attackerTenant,
              purpose: attackerPurpose,
              actorUid: attackerUid,
            });
            expect(attackerHash).toMatch(HASH_RE);
            expect(attackerHash).not.toBe(victimHash);

            // Same crafted key inside the VICTIM's tenant but a different actor:
            // still must not reach the victim's object.
            const sameTenantOtherActor = deriveUploadKeyHash({
              uploadKey: crafted,
              tenantId: victimTenant,
              purpose: victimPurpose,
              actorUid: attackerUid,
            });
            expect(sameTenantOtherActor).not.toBe(victimHash);

            // And the crafted key never reproduces the victim's hash even when the
            // whole scope matches, because the key itself differs from the genuine one.
            const sameScopeCraftedKey = deriveUploadKeyHash({
              uploadKey: crafted,
              tenantId: victimTenant,
              purpose: victimPurpose,
              actorUid: victimUid,
            });
            expect(sameScopeCraftedKey).not.toBe(victimHash);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
