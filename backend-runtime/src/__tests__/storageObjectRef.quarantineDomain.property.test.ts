// Feature: storage-orphan-cleanup, Property 8: Hard delete is structurally confined to the quarantine namespace
/**
 * Property 8: Hard delete is structurally confined to the quarantine namespace
 *
 * For any string `s`, `purgeExpiredQuarantine` deletes `s` only if
 * `parseQuarantinePath(s) !== null`. And for any object path `p` that
 * `classifyTenantScopedPath` accepts for any tenant, `parseQuarantinePath(p) === null`.
 *
 * Together: NO LIVE OBJECT PATH IS IN THE DELETE STAGE'S DOMAIN.
 *
 * Asserted in both directions, which is the whole point of the property:
 *
 *   forward   for generated quarantine paths, `parseQuarantinePath` accepts and
 *             recovers `tenantId`, `sweepId` and `objectPath` EXACTLY;
 *   backward  for generated live paths across all six categories that
 *             `classifyTenantScopedPath` accepts, `parseQuarantinePath` returns
 *             `null`.
 *
 * The guarantee is structural — a consequence of the two functions' domains being
 * disjoint, because acceptance here requires a first segment of
 * `_orphan-quarantine` and acceptance there requires a first segment in
 * `STORAGE_TENANT_CATEGORIES`, of which `QUARANTINE_PREFIX` is deliberately not a
 * member — rather than a procedural "we check first". So a bug in the reference
 * enumeration can quarantine a referenced object, but cannot destroy one.
 *
 * **Validates: Requirements 12.1, 12.2, 12.3**
 *
 * _Requirements: 18.2, 18.3, 18.4_
 */
import * as fc from 'fast-check';

import {
  QUARANTINE_PREFIX,
  STORAGE_TENANT_CATEGORIES,
  buildQuarantinePath,
  classifyTenantScopedPath,
  parseQuarantinePath,
} from '../lib/storageObjectRef';

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
  '_leading-underscore',
  QUARANTINE_PREFIX, // a tenant id that spells the namespace: still just a segment
);

const sweepIdArb = fc.constantFrom(
  'sweep_1700000000000_ab12cd',
  's1',
  'run-2024-03-01',
  '..x',
  'a b',
  '%2F',
  QUARANTINE_PREFIX,
);

const categoryArb = fc.constantFrom(...STORAGE_TENANT_CATEGORIES);

/** Path tails, including ones that reintroduce the quarantine prefix deeper down. */
const tailArb = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.constantFrom(
      'object.bin',
      '1700000000000_holiday photo.jpg',
      'k_3b1c9d0e5f7a2b4c6d8e_clip_h264.mp4',
      'audio/notice_audio_k_dead0dead0dead0dead0.m4a',
      'fee_77/k_beefbeefbeefbeefbeef_march.pdf',
      '0123456789abcdef0123.jpg',
      'a/b/c/d/e.png',
      '50%2F50 split.png',
      '日本語のファイル.png',
      `${QUARANTINE_PREFIX}/looks-nested.bin`,
    ),
  },
  {
    weight: 2,
    arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 }).map((s) => `f_${s}.bin`),
  },
);

/** A live tenant-scoped path: `{category}/{tenantId}/{tail}`. */
const livePathArb: fc.Arbitrary<{ objectPath: string; tenantId: string }> = fc
  .tuple(categoryArb, tenantIdArb, tailArb)
  .map(([category, tenantId, tail]) => ({ objectPath: `${category}/${tenantId}/${tail}`, tenantId }));

describe('Property 8: Hard delete is structurally confined to the quarantine namespace', () => {
  // -------------------------------------------------------------------------
  // Forward direction: generated quarantine paths are accepted and recovered
  // -------------------------------------------------------------------------
  it('forward: parseQuarantinePath recovers tenantId, sweepId and objectPath exactly', () => {
    fc.assert(
      fc.property(livePathArb, sweepIdArb, ({ objectPath, tenantId }, sweepId) => {
        // Built the only way the mover is allowed to build it.
        const quarantinePath = buildQuarantinePath({ tenantId, sweepId, objectPath });
        expect(quarantinePath).toBe(`${QUARANTINE_PREFIX}/${tenantId}/${sweepId}/${objectPath}`);

        const parsed = parseQuarantinePath(quarantinePath);
        expect(parsed).toEqual({ tenantId, sweepId, objectPath });

        // Exact inverse, so the purger can reconstruct the original path from the
        // quarantine path ALONE — the manifest stays a convenience rather than the
        // safety mechanism.
        expect(parsed).not.toBeNull();
        if (!parsed) return;
        expect(buildQuarantinePath(parsed)).toBe(quarantinePath);
      }),
      { numRuns: 300 },
    );
  });

  it('forward: recovery is exact for an arbitrary multi-segment object portion', () => {
    // The purger's domain is defined by string shape, not by what the mover
    // happened to produce, so the parse is asserted over hand-assembled paths too.
    fc.assert(
      fc.property(
        tenantIdArb,
        sweepIdArb,
        fc.array(tailArb, { minLength: 1, maxLength: 4 }),
        (tenantId, sweepId, tails) => {
          const objectPath = tails.join('/');
          const quarantinePath = `${QUARANTINE_PREFIX}/${tenantId}/${sweepId}/${objectPath}`;
          expect(parseQuarantinePath(quarantinePath)).toEqual({ tenantId, sweepId, objectPath });
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // Backward direction: every live path is refused
  // -------------------------------------------------------------------------
  it('backward: every live path the scope guard accepts is refused by parseQuarantinePath', () => {
    // THE assertion of this batch. If it can be made to pass while a live path is
    // parseable, the hard-delete stage can reach a live object.
    fc.assert(
      fc.property(livePathArb, ({ objectPath, tenantId }) => {
        expect(classifyTenantScopedPath(objectPath, tenantId).ok).toBe(true);
        expect(parseQuarantinePath(objectPath)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it('backward: no path accepted by parseQuarantinePath is accepted by the live scope guard', () => {
    // The same disjointness read the other way round, and for ANY tenant rather
    // than only the one named in the path.
    fc.assert(
      fc.property(livePathArb, sweepIdArb, tenantIdArb, ({ objectPath, tenantId }, sweepId, otherTenantId) => {
        const quarantinePath = buildQuarantinePath({ tenantId, sweepId, objectPath });
        expect(parseQuarantinePath(quarantinePath)).not.toBeNull();

        for (const scopeTenant of [tenantId, otherTenantId, sweepId]) {
          expect(classifyTenantScopedPath(quarantinePath, scopeTenant)).toEqual({
            ok: false,
            reason: 'not_managed_category',
          });
        }
      }),
      { numRuns: 300 },
    );
  });

  it('backward: the quarantine prefix is not a managed category, which is what makes the domains disjoint', () => {
    expect(STORAGE_TENANT_CATEGORIES).not.toContain(QUARANTINE_PREFIX);
    for (const category of STORAGE_TENANT_CATEGORIES) {
      expect(category.startsWith(QUARANTINE_PREFIX)).toBe(false);
      expect(QUARANTINE_PREFIX.startsWith(category)).toBe(false);
    }
  });

  it('refuses quarantine-shaped strings that are not invertible', () => {
    fc.assert(
      fc.property(tenantIdArb, sweepIdArb, tailArb, (tenantId, sweepId, tail) => {
        // Too shallow: no object portion at all.
        expect(parseQuarantinePath(QUARANTINE_PREFIX)).toBeNull();
        expect(parseQuarantinePath(`${QUARANTINE_PREFIX}/${tenantId}`)).toBeNull();
        expect(parseQuarantinePath(`${QUARANTINE_PREFIX}/${tenantId}/${sweepId}`)).toBeNull();
        expect(parseQuarantinePath(`${QUARANTINE_PREFIX}/${tenantId}/${sweepId}/`)).toBeNull();
        // An empty tenant or sweep segment would make the parse ambiguous.
        expect(parseQuarantinePath(`${QUARANTINE_PREFIX}//${sweepId}/${tail}`)).toBeNull();
        expect(parseQuarantinePath(`${QUARANTINE_PREFIX}/${tenantId}//${tail}`)).toBeNull();
        // A neighbouring namespace is not the namespace.
        expect(parseQuarantinePath(`${QUARANTINE_PREFIX}-2/${tenantId}/${sweepId}/${tail}`)).toBeNull();
        expect(parseQuarantinePath(`x${QUARANTINE_PREFIX}/${tenantId}/${sweepId}/${tail}`)).toBeNull();
        // The prefix must be the FIRST segment, not merely present.
        expect(parseQuarantinePath(`notices/${QUARANTINE_PREFIX}/${tenantId}/${sweepId}/${tail}`)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
