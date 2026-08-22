// Feature: storage-orphan-cleanup, Property 2: Tenant-prefix confinement
/**
 * Property 2: Tenant-prefix confinement
 *
 * For any `tenantId` and any object path — including paths with `../`, `..\`,
 * `%2e%2e%2f`, `....//`, a leading `/`, a NUL, Unicode look-alikes of the tenant
 * id, a tenant id that is a PREFIX of another tenant's id, and empty segments —
 * every path the sweep admits to `retainPaths`, every path it quarantines and
 * every path it hard-deletes satisfies
 * `objectPath.startsWith(`${category}/${tenantId}/`)` for a category in
 * `STORAGE_TENANT_CATEGORIES` (or, for the delete stage,
 * `QUARANTINE_PREFIX/${tenantId}/`).
 *
 * All three guard points are pure functions in this module, so all three are
 * asserted here rather than only the first:
 *
 *   1. retain-set admission        `classifyTenantScopedPath`
 *   2. immediately before a move   `assertTenantScoped` + `buildQuarantinePath`
 *   3. before a hard delete        `parseQuarantinePath` + `assertTenantScoped`
 *                                  on the RECONSTRUCTED original path
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
 *
 * ---------------------------------------------------------------------------
 * The hostile-string generator is reused from
 * `uploadObjectPath.traversal.property.test.ts`, per task 1.6, and fed into every
 * path position — the category segment, the tenant segment and the remainder —
 * because a guard that is only correct for well-formed input is not a guard.
 *
 * Note the assertions are SEGMENT-level, not substring-level, for the same reason
 * that test documents: `sanitizeStorageSegment` maps `../../x` to `.._.._x`,
 * which legitimately CONTAINS `..` while being one confined segment.
 *
 * _Requirements: 18.2, 18.3, 18.4_
 */
import * as fc from 'fast-check';

import {
  QUARANTINE_PREFIX,
  STORAGE_TENANT_CATEGORIES,
  TenantScopeViolation,
  assertTenantScoped,
  buildQuarantinePath,
  classifyTenantScopedPath,
  parseQuarantinePath,
} from '../lib/storageObjectRef';

const MANAGED_CATEGORIES: ReadonlySet<string> = new Set<string>(STORAGE_TENANT_CATEGORIES);

// ---------------------------------------------------------------------------
// Hostile-string generator, mirrored from
// `uploadObjectPath.traversal.property.test.ts`.
// ---------------------------------------------------------------------------
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
  // Overlong UTF-8 sequences as they arrive when a latin-1 decode is applied
  '\u00c0\u00ae\u00c0\u00ae\u00c0\u00af',
  '\u00e0\u0080\u00ae\u00e0\u0080\u00af',
  '..%c0%af',
  '%c0%ae%c0%ae/',
  // Unicode look-alikes for '.' and '/'
  '\uff0e\uff0e\uff0f',
  '\u2024\u2024\u2215',
  '\u2044',
  '\u29f8',
  '\uff3c',
  '\u2e2e',
  '\u202e',
  '\ufeff',
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

const LONG_HOSTILE: string[] = [
  '../'.repeat(400),
  '..\\'.repeat(400),
  '.'.repeat(4096),
  'a'.repeat(8192),
  `${'../'.repeat(200)}etc/passwd`,
  `${'A'.repeat(2000)}\u0000${'../'.repeat(50)}`,
];

const hostileTokenArb = fc.constantFrom(...HOSTILE_TOKENS);

const hostileStringArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.array(hostileTokenArb, { minLength: 1, maxLength: 6 }).map((parts) => parts.join('')),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(hostileTokenArb, fc.string({ maxLength: 16 }), hostileTokenArb)
      .map(([a, mid, b]) => `${a}${mid}${b}`),
  },
  { weight: 2, arbitrary: fc.constantFrom(...LONG_HOSTILE) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 48 }) },
  { weight: 1, arbitrary: fc.constant('') },
);

// ---------------------------------------------------------------------------
// Tenant ids, INCLUDING pairs where one is a strict prefix of the other. This is
// the case a naive `startsWith(tenantId)` check gets wrong, letting `acme` reach
// `acme-2`'s objects.
// ---------------------------------------------------------------------------
const TENANT_PREFIX_PAIRS: readonly (readonly [string, string])[] = [
  ['acme', 'acme-2'],
  ['acme', 'acme2'],
  ['acme', 'acme_backup'],
  ['t', 't1'],
  ['tenant.co', 'tenant.co.uk'],
  ['T-42', 'T-420'],
  ['a', 'a'.repeat(30)],
];

const tenantPrefixPairArb = fc.constantFrom(...TENANT_PREFIX_PAIRS);

const plainTenantIdArb = fc.constantFrom(
  'acme',
  'acme-2',
  'tenant_1',
  'T-42',
  'x',
  'tenant.co',
  'abcdefghijklmnopqrst0123456789',
);

/** Tenant ids that are NOT single plain segments, plus hostile strings. */
const anyTenantIdArb = fc.oneof(
  { weight: 5, arbitrary: plainTenantIdArb },
  { weight: 2, arbitrary: fc.constantFrom('', ' ', '.', '..', 'a/b', 'a\u0000b', '/', 'acme/') },
  { weight: 2, arbitrary: hostileStringArb },
);

const categoryPositionArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...STORAGE_TENANT_CATEGORIES) },
  { weight: 2, arbitrary: fc.constantFrom(QUARANTINE_PREFIX, 'invoices', 'chat-file', 'CHAT-FILES', '') },
  { weight: 2, arbitrary: hostileStringArb },
);

const remainderArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('object.bin', 'audio/notice_audio_k_dead.m4a', 'a/b/c.png') },
  { weight: 4, arbitrary: hostileStringArb },
);

/** Sweep ids that ARE single plain path segments, so a built path is invertible. */
const plainSweepIdArb = fc.constantFrom(
  'sweep_1700000000000_ab12cd',
  's1',
  'run-2024-03-01',
  '..x',
  'a b',
);

const sweepIdArb = fc.oneof(
  { weight: 5, arbitrary: plainSweepIdArb },
  { weight: 2, arbitrary: fc.constantFrom('', '.', '..', 'a/b', 'a\u0000b') },
  { weight: 2, arbitrary: hostileStringArb },
);

/**
 * A path assembled from three independently hostile positions, plus whole-string
 * hostile values and a few realistic ones — so the guard is exercised both on
 * shapes that nearly pass and on shapes that are pure garbage.
 */
const objectPathArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(categoryPositionArb, anyTenantIdArb, remainderArb)
      .map(([category, tenant, remainder]) => `${category}/${tenant}/${remainder}`),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.constantFrom(...STORAGE_TENANT_CATEGORIES), plainTenantIdArb, hostileStringArb)
      .map(([category, tenant, suffix]) => `${category}/${tenant}${suffix}/object.bin`),
  },
  { weight: 2, arbitrary: hostileStringArb },
);

// ---------------------------------------------------------------------------
// Shared assertion: what "confined" means, at every guard point.
// ---------------------------------------------------------------------------
function assertConfinedToTenant(objectPath: string, tenantId: string): void {
  const scope = classifyTenantScopedPath(objectPath, tenantId);
  expect(scope.ok).toBe(true);
  if (!scope.ok) return;

  expect(MANAGED_CATEGORIES.has(scope.category)).toBe(true);
  expect(objectPath.startsWith(`${scope.category}/${tenantId}/`)).toBe(true);

  const segments = objectPath.split('/');
  expect(segments.length).toBeGreaterThanOrEqual(3);
  expect(segments[0]).toBe(scope.category);
  // A WHOLE segment, never a prefix: this is the `acme` / `acme-2` guarantee.
  expect(segments[1]).toBe(tenantId);
  expect(segments.slice(2).some((segment) => segment.length > 0)).toBe(true);
}

describe('Property 2: Tenant-prefix confinement', () => {
  // -------------------------------------------------------------------------
  // Guard point 1 — retain-set admission
  // -------------------------------------------------------------------------
  it('guard 1: every path the scope guard accepts is confined to {category}/{tenantId}/', () => {
    fc.assert(
      fc.property(objectPathArb, anyTenantIdArb, (objectPath, tenantId) => {
        const scope = classifyTenantScopedPath(objectPath, tenantId);
        if (!scope.ok) {
          expect(['not_managed_category', 'tenant_mismatch', 'too_shallow']).toContain(scope.reason);
          return;
        }
        assertConfinedToTenant(objectPath, tenantId);
        // The quarantine namespace is never a live category, in either direction.
        expect(scope.category).not.toBe(QUARANTINE_PREFIX);
        expect(objectPath.startsWith(`${QUARANTINE_PREFIX}/`)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('guard 1: one tenant can never reach the objects of a tenant whose id it prefixes', () => {
    fc.assert(
      fc.property(
        tenantPrefixPairArb,
        fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
        remainderArb,
        ([shorter, longer], category, remainder) => {
          const shorterPath = `${category}/${shorter}/${remainder}`;
          const longerPath = `${category}/${longer}/${remainder}`;

          if (shorter !== longer) {
            // Never accepted, whatever the remainder looks like.
            expect(classifyTenantScopedPath(longerPath, shorter).ok).toBe(false);
            expect(classifyTenantScopedPath(shorterPath, longer).ok).toBe(false);
            // And the mutation guard refuses both, non-retryably.
            expect(() => assertTenantScoped(longerPath, shorter)).toThrow(TenantScopeViolation);
            expect(() => assertTenantScoped(shorterPath, longer)).toThrow(TenantScopeViolation);

            // Where the path is otherwise well formed — i.e. accepted for its OWN
            // tenant — the rejection is specifically `tenant_mismatch`, which is
            // the reason a `startsWith` check would have got wrong. (A remainder
            // that is empty or all-empty segments is rejected earlier as
            // `too_shallow`; the guard's documented branch order is
            // too_shallow → not_managed_category → tenant_mismatch.)
            if (classifyTenantScopedPath(longerPath, longer).ok) {
              expect(classifyTenantScopedPath(longerPath, shorter)).toEqual({
                ok: false,
                reason: 'tenant_mismatch',
              });
            }
            if (classifyTenantScopedPath(shorterPath, shorter).ok) {
              expect(classifyTenantScopedPath(shorterPath, longer)).toEqual({
                ok: false,
                reason: 'tenant_mismatch',
              });
            }
          }

          // Each tenant still reaches its own objects, so the guard is a guard and
          // not simply a refusal.
          if (classifyTenantScopedPath(shorterPath, shorter).ok) {
            assertConfinedToTenant(shorterPath, shorter);
          }
          if (classifyTenantScopedPath(longerPath, longer).ok) {
            assertConfinedToTenant(longerPath, longer);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // Guard point 2 — immediately before a quarantine move
  // -------------------------------------------------------------------------
  it('guard 2: a quarantine destination is only ever built from an already-asserted path', () => {
    fc.assert(
      fc.property(objectPathArb, anyTenantIdArb, sweepIdArb, (objectPath, tenantId, sweepId) => {
        const scope = classifyTenantScopedPath(objectPath, tenantId);

        let built: string | null = null;
        let thrown: unknown = null;
        try {
          built = buildQuarantinePath({ tenantId, sweepId, objectPath });
        } catch (err) {
          thrown = err;
        }

        if (!scope.ok) {
          // Scope is asserted FIRST, so a path outside the tenant always fails
          // here — whatever else is wrong with the arguments — and it fails
          // non-retryably.
          expect(thrown).toBeInstanceOf(TenantScopeViolation);
          expect((thrown as TenantScopeViolation).retryable).toBe(false);
          expect((thrown as TenantScopeViolation).reason).toBe(scope.reason);
          expect(built).toBeNull();
          return;
        }

        // In scope: the only remaining reason to refuse is an unusable sweepId,
        // which would make the destination non-invertible.
        const sweepIdUsable =
          sweepId.length > 0 &&
          !sweepId.includes('/') &&
          !sweepId.includes('\u0000') &&
          sweepId !== '.' &&
          sweepId !== '..';
        if (!sweepIdUsable) {
          expect(thrown).toBeInstanceOf(TypeError);
          return;
        }

        expect(thrown).toBeNull();
        expect(built).toBe(`${QUARANTINE_PREFIX}/${tenantId}/${sweepId}/${objectPath}`);
        // The destination is confined to the tenant's own quarantine folder.
        expect((built as string).startsWith(`${QUARANTINE_PREFIX}/${tenantId}/`)).toBe(true);
        // And the source it was built from is confined too.
        assertConfinedToTenant(objectPath, tenantId);
      }),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Guard point 3 — before a hard delete
  // -------------------------------------------------------------------------
  it('guard 3: a hard delete only ever names a quarantine path whose reconstructed original is in scope', () => {
    const quarantineLikeArb = fc.oneof(
      {
        weight: 5,
        arbitrary: fc
          .tuple(anyTenantIdArb, sweepIdArb, objectPathArb)
          .map(([tenantId, sweepId, objectPath]) => `${QUARANTINE_PREFIX}/${tenantId}/${sweepId}/${objectPath}`),
      },
      { weight: 2, arbitrary: objectPathArb },
      { weight: 2, arbitrary: hostileStringArb },
    );

    fc.assert(
      fc.property(quarantineLikeArb, (candidate) => {
        const parsed = parseQuarantinePath(candidate);
        if (!parsed) return;

        // Structural: anything the purger's domain admits is inside the
        // quarantine namespace, for the tenant named in the path itself.
        expect(candidate.startsWith(`${QUARANTINE_PREFIX}/${parsed.tenantId}/${parsed.sweepId}/`)).toBe(true);
        expect(parsed.objectPath.length).toBeGreaterThan(0);

        // The third guard runs on the RECONSTRUCTED original path. When it
        // passes, that path is confined to the same tenant; when it does not, the
        // delete does not happen.
        const scope = classifyTenantScopedPath(parsed.objectPath, parsed.tenantId);
        if (!scope.ok) {
          expect(() => assertTenantScoped(parsed.objectPath, parsed.tenantId)).toThrow(TenantScopeViolation);
          return;
        }
        expect(() => assertTenantScoped(parsed.objectPath, parsed.tenantId)).not.toThrow();
        assertConfinedToTenant(parsed.objectPath, parsed.tenantId);
        expect(candidate).toBe(`${QUARANTINE_PREFIX}/${parsed.tenantId}/${parsed.sweepId}/${parsed.objectPath}`);
      }),
      { numRuns: 300 },
    );
  });

  it('guard 3: a nested quarantine path never passes the scope guard on its reconstructed original', () => {
    // Quarantining a quarantine path would let the purger reconstruct something
    // still inside the namespace; the guard refuses it because
    // `_orphan-quarantine` is not a managed category.
    fc.assert(
      fc.property(plainTenantIdArb, plainSweepIdArb, sweepIdArb, remainderArb, (tenantId, outer, inner, remainder) => {
        const nested = `${QUARANTINE_PREFIX}/${tenantId}/${outer}/${QUARANTINE_PREFIX}/${tenantId}/${inner}/notices/${tenantId}/${remainder}`;
        const parsed = parseQuarantinePath(nested);
        if (!parsed) return;
        expect(parsed.objectPath.startsWith(`${QUARANTINE_PREFIX}/`)).toBe(true);
        expect(classifyTenantScopedPath(parsed.objectPath, parsed.tenantId)).toEqual({
          ok: false,
          reason: 'not_managed_category',
        });
        expect(() => assertTenantScoped(parsed.objectPath, parsed.tenantId)).toThrow(TenantScopeViolation);
      }),
      { numRuns: 200 },
    );
  });
});
