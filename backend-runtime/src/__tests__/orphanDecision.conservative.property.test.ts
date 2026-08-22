// Feature: storage-orphan-cleanup, Property 1: Conservative retention — anything not provably unreferenced is retained
/**
 * Property 1: Conservative retention — anything not provably unreferenced is
 * retained
 *
 * For any object path, any retain set, any `lastTouchedMs` (including `null`,
 * `NaN`, `Infinity`, negative and far-future values) and any grace cutoff,
 * `decideObjectDisposition` returns `action: 'report'` **only when all** of the
 * following hold:
 *
 *   1. the path is `{category}/{tenantId}/…` for a category in
 *      `STORAGE_TENANT_CATEGORIES`;
 *   2. the path is not under `QUARANTINE_PREFIX`;
 *   3. the path is absent from `retainPaths`;
 *   4. `lastTouchedMs` is a usable epoch-ms value; and
 *   5. `lastTouchedMs < graceCutoffMs`.
 *
 * Negating any single conjunct yields `action: 'retain'`.
 *
 * Additionally the decision is **monotone** in the retain set: for any path `p`
 * and any sets `A ⊆ B`, if `decide(p, A) = retain` then `decide(p, B) = retain`.
 * Over-collecting references can therefore only ever be safe.
 *
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12**
 *
 * ---------------------------------------------------------------------------
 * This is the whole spec in one statement, which is why it is asserted in three
 * complementary directions rather than one:
 *
 *   - the **characterisation**: `report` ⟺ all five conjuncts, over the full
 *     cross product of path shapes, retain-set membership and the whole
 *     `lastTouchedMs` space. Stated over the conjuncts alone, so it is
 *     independent of the branch ORDER the module happens to use;
 *   - the **contrapositive**: from a scenario that does report, negating each
 *     single conjunct yields `retain` with the specific expected reason;
 *   - **monotonicity**, which is what makes over-collecting references safe and
 *     therefore what makes every "offer this field too" decision in the collector
 *     a free one.
 *
 * One implementation detail that is deliberately asserted as implemented rather
 * than as one might first read Requirement 1.7: because `QUARANTINE_PREFIX` is
 * NOT a managed category, a quarantine path has already failed conjunct 1 by the
 * time conjunct 2 is examined. The quarantine test therefore refines the REASON
 * from `unmanaged_path` to `quarantine_path`; it never changes the action, which
 * is `retain` on both branches. That is the only reading of the documented
 * `scope → quarantine → referenced → grace → age` order under which both Req 1.6
 * and Req 1.7 are reachable, and it is what the module documents.
 *
 * _Requirements: 18.2, 18.3, 18.4_
 */
import * as fc from 'fast-check';

import { DAY_MS, decideObjectDisposition } from '../lib/orphanDecision';
import type { DecisionContext, ObjectDisposition, ObjectFacts } from '../lib/orphanDecision';
import {
  QUARANTINE_PREFIX,
  STORAGE_TENANT_CATEGORIES,
  classifyTenantScopedPath,
} from '../lib/storageObjectRef';

// ---------------------------------------------------------------------------
// The five conjuncts, restated independently of the module's branch order.
//
// Conjunct 1 is evaluated with the shared `classifyTenantScopedPath` on purpose:
// it IS the spec's definition of Tenant_Scope, and Property 2 is what asserts
// that function's own correctness. Conjuncts 2, 4 and 5 are spelled out here so
// this file is not a mirror of the implementation.
// ---------------------------------------------------------------------------
function inTenantScope(objectPath: string, tenantId: string): boolean {
  return classifyTenantScopedPath(objectPath, tenantId).ok;
}

function underQuarantinePrefix(objectPath: string): boolean {
  const segments = objectPath.split('/');
  return segments[0] === QUARANTINE_PREFIX;
}

/** Conjunct 4: a value that could be an instant at which an object was touched. */
function isUsableAge(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const RETAIN_REASONS = [
  'referenced',
  'within_grace',
  'age_unknown',
  'unmanaged_path',
  'quarantine_path',
] as const;

// ---------------------------------------------------------------------------
// Generators: path shapes.
// ---------------------------------------------------------------------------
const PLAIN_TENANTS = ['acme', 'acme-2', 'tenant_1', 'T-42'] as const;

const tenantIdArb = fc.constantFrom(...PLAIN_TENANTS);

const categoryArb = fc.constantFrom(...STORAGE_TENANT_CATEGORIES);

/** Categories that are NOT managed, including near-misses and the quarantine prefix. */
const unmanagedCategoryArb = fc.constantFrom(
  'invoices',
  'exports',
  'chat-file',
  'chat-filess',
  'CHAT-FILES',
  'Receipts',
  'student-profiles', // the hyphenated spelling; the real one is snake_case
  '',
  ' ',
  QUARANTINE_PREFIX,
);

const remainderArb = fc.constantFrom(
  'object.bin',
  'a/b/c.png',
  'audio/notice_audio_k_dead0dead0dead0dead0.m4a',
  'fee_77/k_beefbeefbeefbeefbeef_march.pdf',
  '0123456789abcdef0123.jpg',
  'c_9f2a/k_3b1c9d0e5f7a2b4c6d8e_clip_h264.mp4',
  'holiday photo.jpg',
  '50%2F50 split.png',
);

const sweepIdArb = fc.constantFrom('sweep_1700000000000_ab12cd', 's1', 'run-2024-03-01');

/** Traversal and otherwise structurally broken paths. */
const traversalArb = fc.constantFrom(
  '../../etc/passwd',
  'receipts/acme/../x.pdf',
  '/receipts/acme/x.pdf',
  'receipts//acme/x.pdf',
  'receipts/acme',
  'receipts/acme/',
  'receipts',
  '',
  '/',
  '..',
  '.',
  'receipts/%2e%2e/acme/x.pdf',
  'receipts/acme\u0000/x.pdf',
  '\u0000',
  'receipts/\uff41\uff43\uff4d\uff45/x.pdf', // full-width look-alike of "acme"
  'a'.repeat(2000),
);

function isPlainTenant(segment: string | undefined): boolean {
  return typeof segment === 'string' && (PLAIN_TENANTS as readonly string[]).includes(segment);
}

const objectPathArb: fc.Arbitrary<string> = fc.oneof(
  // In scope for SOME tenant in `PLAIN_TENANTS` — the shapes that can report.
  {
    weight: 8,
    arbitrary: fc
      .tuple(categoryArb, tenantIdArb, remainderArb)
      .map(([category, tenantId, remainder]) => `${category}/${tenantId}/${remainder}`),
  },
  // A seventh category, or a near-miss spelling of a real one.
  {
    weight: 3,
    arbitrary: fc
      .tuple(unmanagedCategoryArb, tenantIdArb, remainderArb)
      .map(([category, tenantId, remainder]) => `${category}/${tenantId}/${remainder}`),
  },
  // The quarantine namespace, including its degenerate shapes.
  {
    weight: 3,
    arbitrary: fc.oneof(
      fc
        .tuple(tenantIdArb, sweepIdArb, categoryArb, tenantIdArb, remainderArb)
        .map(
          ([owner, sweepId, category, tenantId, remainder]) =>
            `${QUARANTINE_PREFIX}/${owner}/${sweepId}/${category}/${tenantId}/${remainder}`,
        ),
      fc.constantFrom(
        QUARANTINE_PREFIX,
        `${QUARANTINE_PREFIX}/`,
        `${QUARANTINE_PREFIX}/acme`,
        `${QUARANTINE_PREFIX}/acme/s1`,
      ),
      // A sibling of the prefix, which must NOT be read as quarantine.
      fc.constantFrom(`${QUARANTINE_PREFIX}-old/acme/x.pdf`, `${QUARANTINE_PREFIX}2/acme/x.pdf`),
    ),
  },
  { weight: 3, arbitrary: traversalArb },
);

// ---------------------------------------------------------------------------
// Generators: the time axis.
//
// `lastTouchedMs` is generated RELATIVE to the injected cutoff so that both sides
// of the boundary — and the boundary itself — are hit densely, rather than being
// a measure-zero event inside a wide integer range.
// ---------------------------------------------------------------------------
const REALISTIC_NOW = Date.parse('2026-04-01T00:00:00Z');

const cutoffArb = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      REALISTIC_NOW - 1 * DAY_MS,
      REALISTIC_NOW - 7 * DAY_MS,
      REALISTIC_NOW - 365 * DAY_MS,
    ),
  },
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 4_000_000_000_000 }) },
  // Degenerate cutoffs: a mis-computed cutoff must retain, never report.
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      0,
      1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ),
  },
);

const OFFSETS = [-1, 0, 1, -2, 2, -1000, 1000, -DAY_MS, DAY_MS, -400 * DAY_MS, 400 * DAY_MS];

type AgeSpec = { kind: 'relative'; offset: number } | { kind: 'absolute'; value: number | null };

const ageSpecArb: fc.Arbitrary<AgeSpec> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...OFFSETS).map((offset) => ({ kind: 'relative' as const, offset })) },
  {
    weight: 3,
    arbitrary: fc
      .integer({ min: -500 * DAY_MS, max: 500 * DAY_MS })
      .map((offset) => ({ kind: 'relative' as const, offset })),
  },
  {
    weight: 4,
    arbitrary: fc
      .constantFrom<number | null>(
        null,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -1,
        -1_700_000_000_000,
        0,
        1,
        8_640_000_000_000_000,
      )
      .map((value) => ({ kind: 'absolute' as const, value })),
  },
);

function resolveAge(spec: AgeSpec, graceCutoffMs: number): number | null {
  return spec.kind === 'absolute' ? spec.value : graceCutoffMs + spec.offset;
}

const bytesArb = fc.oneof(
  fc.constantFrom<number | null>(null, 0, -1, 1, 1024, Number.NaN, Number.POSITIVE_INFINITY),
  fc.integer({ min: 0, max: 10_000_000_000 }),
);

/**
 * A path together with the tenant being swept. Half the time the swept tenant is
 * taken FROM the path, which is what keeps in-scope paths — and therefore the
 * `report` branch — a dense event rather than a coincidence of two independent
 * draws. Without this the corpus is dominated by `unmanaged_path` and the
 * characterisation below would hold vacuously.
 */
const pathAndTenantArb = fc
  .record({
    objectPath: objectPathArb,
    tenantId: tenantIdArb,
    matchPathTenant: fc.boolean(),
  })
  .map(({ objectPath, tenantId, matchPathTenant }) => {
    const segment = objectPath.split('/')[1];
    return {
      objectPath,
      tenantId: matchPathTenant && isPlainTenant(segment) ? segment : tenantId,
    };
  });

// ---------------------------------------------------------------------------
// A whole scenario.
// ---------------------------------------------------------------------------
interface Scenario {
  facts: ObjectFacts;
  context: DecisionContext;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    target: pathAndTenantArb,
    graceCutoffMs: cutoffArb,
    age: ageSpecArb,
    bytes: bytesArb,
    // Forcing the path itself into the retain set half the time is what makes
    // membership a dense event rather than an accident.
    includeSelf: fc.boolean(),
    otherRetained: fc.array(objectPathArb, { maxLength: 4 }),
  })
  .map(({ target, graceCutoffMs, age, bytes, includeSelf, otherRetained }) => {
    const { objectPath, tenantId } = target;
    const retainPaths = new Set<string>(otherRetained);
    if (includeSelf) retainPaths.add(objectPath);
    return {
      facts: { objectPath, lastTouchedMs: resolveAge(age, graceCutoffMs), bytes },
      context: { tenantId, retainPaths, graceCutoffMs },
    };
  });

describe('Property 1: Conservative retention', () => {
  // -------------------------------------------------------------------------
  // The characterisation: `report` ⟺ all five conjuncts hold.
  // -------------------------------------------------------------------------
  it('reports if and only if all five conjuncts hold, and retains otherwise', () => {
    // Coverage counters: a characterisation that only ever saw `retain` would
    // pass vacuously, so the corpus is required to have exercised every branch.
    const seen = new Set<string>();

    fc.assert(
      fc.property(scenarioArb, ({ facts, context }) => {
        const disposition = decideObjectDisposition(facts, context);

        const c1 = inTenantScope(facts.objectPath, context.tenantId);
        const c2 = !underQuarantinePrefix(facts.objectPath);
        const c3 = !context.retainPaths.has(facts.objectPath);
        const c4 = isUsableAge(facts.lastTouchedMs);
        const c5 = c4 && (facts.lastTouchedMs as number) < context.graceCutoffMs;

        const provablyUnreferenced = c1 && c2 && c3 && c4 && c5;

        expect(disposition.action).toBe(provablyUnreferenced ? 'report' : 'retain');

        if (disposition.action === 'report') {
          expect(disposition.reason).toBe('unreferenced');
        } else {
          expect(RETAIN_REASONS).toContain(disposition.reason);
        }
        // The disposition is exactly the declared two-field shape.
        expect(Object.keys(disposition).sort()).toEqual(['action', 'reason']);

        seen.add(`${disposition.action}:${disposition.reason}`);
      }),
      { numRuns: 500 },
    );

    expect([...seen].sort()).toEqual([
      'report:unreferenced',
      'retain:age_unknown',
      'retain:quarantine_path',
      'retain:referenced',
      'retain:unmanaged_path',
      'retain:within_grace',
    ]);
  });

  it('never throws, for any generated scenario', () => {
    fc.assert(
      fc.property(scenarioArb, ({ facts, context }) => {
        expect(() => decideObjectDisposition(facts, context)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // The contrapositive: negate one conjunct at a time.
  // -------------------------------------------------------------------------
  const reportingBaseArb = fc
    .record({
      category: categoryArb,
      tenantId: tenantIdArb,
      remainder: remainderArb,
      graceCutoffMs: fc.integer({ min: 10 * DAY_MS, max: 4_000_000_000_000 }),
      ageBelowCutoff: fc.integer({ min: 1, max: 9 * DAY_MS }),
      bytes: bytesArb,
      otherRetained: fc.array(objectPathArb, { maxLength: 3 }),
      sweepId: sweepIdArb,
      unmanagedCategory: fc.constantFrom('invoices', 'exports', 'chat-file', 'Receipts'),
      otherTenantId: tenantIdArb,
    })
    .map((raw) => {
      const objectPath = `${raw.category}/${raw.tenantId}/${raw.remainder}`;
      const retainPaths = new Set<string>(raw.otherRetained.filter((p) => p !== objectPath));
      return {
        ...raw,
        objectPath,
        facts: {
          objectPath,
          lastTouchedMs: raw.graceCutoffMs - raw.ageBelowCutoff,
          bytes: raw.bytes,
        } as ObjectFacts,
        context: {
          tenantId: raw.tenantId,
          retainPaths,
          graceCutoffMs: raw.graceCutoffMs,
        } as DecisionContext,
      };
    });

  it('the base scenario reports, so each negation below is a genuine negation', () => {
    fc.assert(
      fc.property(reportingBaseArb, ({ facts, context }) => {
        expect(decideObjectDisposition(facts, context)).toEqual({
          action: 'report',
          reason: 'unreferenced',
        });
      }),
      { numRuns: 300 },
    );
  });

  it('negating conjunct 1 (tenant scope) yields retain/unmanaged_path', () => {
    fc.assert(
      fc.property(reportingBaseArb, (base) => {
        const { context, remainder, tenantId, category, otherTenantId } = base;

        // (a) a seventh category, same tenant
        const seventh = `${base.unmanagedCategory}/${tenantId}/${remainder}`;
        expect(decideObjectDisposition({ ...base.facts, objectPath: seventh }, context)).toEqual({
          action: 'retain',
          reason: 'unmanaged_path',
        });

        // (b) another tenant's path under a real category
        if (otherTenantId !== tenantId) {
          const crossTenant = `${category}/${otherTenantId}/${remainder}`;
          expect(decideObjectDisposition({ ...base.facts, objectPath: crossTenant }, context)).toEqual({
            action: 'retain',
            reason: 'unmanaged_path',
          });
          // …and the identical path DOES report for its OWN tenant, so the
          // rejection is about the tenant rather than about the path shape.
          // (Unless the generated retain set happens to hold it, in which case
          // conjunct 3 is negated too and the comparison would prove nothing.)
          if (!context.retainPaths.has(crossTenant)) {
            expect(
              decideObjectDisposition(
                { ...base.facts, objectPath: crossTenant },
                { ...context, tenantId: otherTenantId },
              ),
            ).toEqual({ action: 'report', reason: 'unreferenced' });
          }
        }

        // (c) too shallow: the tenant folder itself
        expect(
          decideObjectDisposition({ ...base.facts, objectPath: `${category}/${tenantId}` }, context),
        ).toEqual({ action: 'retain', reason: 'unmanaged_path' });
      }),
      { numRuns: 300 },
    );
  });

  it('negating conjunct 2 (not under QUARANTINE_PREFIX) yields retain/quarantine_path', () => {
    fc.assert(
      fc.property(reportingBaseArb, (base) => {
        // The same object, staged under the quarantine namespace. Note this also
        // negates conjunct 1 — the two domains are provably disjoint — so what is
        // asserted is the documented REFINEMENT of the reason.
        const quarantined = `${QUARANTINE_PREFIX}/${base.tenantId}/${base.sweepId}/${base.objectPath}`;
        expect(decideObjectDisposition({ ...base.facts, objectPath: quarantined }, base.context)).toEqual({
          action: 'retain',
          reason: 'quarantine_path',
        });

        // A sibling of the prefix is NOT the quarantine namespace: it retains for
        // the ordinary reason instead, which is what an operator reads.
        const sibling = `${QUARANTINE_PREFIX}-old/${base.tenantId}/${base.remainder}`;
        expect(decideObjectDisposition({ ...base.facts, objectPath: sibling }, base.context)).toEqual({
          action: 'retain',
          reason: 'unmanaged_path',
        });
      }),
      { numRuns: 300 },
    );
  });

  it('negating conjunct 3 (absent from retainPaths) yields retain/referenced', () => {
    fc.assert(
      fc.property(reportingBaseArb, (base) => {
        const retainPaths = new Set(base.context.retainPaths);
        retainPaths.add(base.objectPath);
        expect(decideObjectDisposition(base.facts, { ...base.context, retainPaths })).toEqual({
          action: 'retain',
          reason: 'referenced',
        });
      }),
      { numRuns: 300 },
    );
  });

  it('negating conjunct 3 requires EXACT string equality against the listing spelling', () => {
    fc.assert(
      fc.property(reportingBaseArb, (base) => {
        // A retain entry that does not compare equal to `file.name` is a
        // deletion, not a mismatch — so near-miss spellings must NOT retain.
        const nearMisses = [
          `${base.objectPath} `,
          ` ${base.objectPath}`,
          `/${base.objectPath}`,
          `${base.objectPath}/`,
          base.objectPath.toUpperCase(),
          encodeURIComponent(base.objectPath),
          base.objectPath.replace(/\//g, '%2F'),
        ].filter((candidate) => candidate !== base.objectPath);

        for (const nearMiss of nearMisses) {
          const retainPaths = new Set(base.context.retainPaths);
          retainPaths.add(nearMiss);
          expect(decideObjectDisposition(base.facts, { ...base.context, retainPaths })).toEqual({
            action: 'report',
            reason: 'unreferenced',
          });
        }
      }),
      { numRuns: 200 },
    );
  });

  it('negating conjunct 4 (a usable lastTouchedMs) yields retain/age_unknown', () => {
    const unusableArb = fc.constantFrom<unknown>(
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -1_700_000_000_000,
      '1700000000000',
      {},
      [],
      true,
    );

    fc.assert(
      fc.property(reportingBaseArb, unusableArb, (base, lastTouchedMs) => {
        const facts = { ...base.facts, lastTouchedMs } as unknown as ObjectFacts;
        expect(decideObjectDisposition(facts, base.context)).toEqual({
          action: 'retain',
          reason: 'age_unknown',
        });
      }),
      { numRuns: 300 },
    );
  });

  it('negating conjunct 5 (lastTouchedMs < graceCutoffMs) yields retain/within_grace', () => {
    fc.assert(
      fc.property(
        reportingBaseArb,
        fc.integer({ min: 0, max: 500 * DAY_MS }),
        (base, aboveCutoff) => {
          // `>= cutoff` includes equality: the comparison is strict, so an object
          // touched exactly AT the cutoff is retained.
          const lastTouchedMs = base.context.graceCutoffMs + aboveCutoff;
          expect(decideObjectDisposition({ ...base.facts, lastTouchedMs }, base.context)).toEqual({
            action: 'retain',
            reason: 'within_grace',
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Monotonicity in the retain set.
  // -------------------------------------------------------------------------
  it('is monotone in the retain set: A ⊆ B and retain under A implies retain under B', () => {
    const supersetArb = fc.record({
      target: pathAndTenantArb,
      graceCutoffMs: cutoffArb,
      age: ageSpecArb,
      bytes: bytesArb,
      a: fc.array(objectPathArb, { maxLength: 4 }),
      extras: fc.array(objectPathArb, { maxLength: 4 }),
      // Adding the path itself is the interesting direction: it is the only
      // addition that can change a `report` into a `retain`.
      addSelf: fc.boolean(),
    });

    let flipsObserved = 0;

    fc.assert(
      fc.property(supersetArb, (raw) => {
        const { objectPath, tenantId } = raw.target;
        const A = new Set<string>(raw.a);
        const B = new Set<string>(A);
        for (const extra of raw.extras) B.add(extra);
        if (raw.addSelf) B.add(objectPath);

        // A ⊆ B, by construction.
        for (const path of A) expect(B.has(path)).toBe(true);

        const facts: ObjectFacts = {
          objectPath,
          lastTouchedMs: resolveAge(raw.age, raw.graceCutoffMs),
          bytes: raw.bytes,
        };
        const under = (retainPaths: ReadonlySet<string>): ObjectDisposition =>
          decideObjectDisposition(facts, { tenantId, retainPaths, graceCutoffMs: raw.graceCutoffMs });

        const underA = under(A);
        const underB = under(B);

        if (underA.action === 'retain') {
          expect(underB.action).toBe('retain');
        }
        // The contrapositive, stated separately because it is the direction an
        // operator cares about: nothing new can become reportable by ADDING a
        // reference.
        if (underB.action === 'report') {
          expect(underA).toEqual({ action: 'report', reason: 'unreferenced' });
        }
        if (underA.action === 'report' && underB.action === 'retain') {
          // The only way a report can be turned off is by the path itself
          // arriving in the retain set.
          expect(underB.reason).toBe('referenced');
          expect(B.has(objectPath)).toBe(true);
          flipsObserved += 1;
        }
      }),
      { numRuns: 500 },
    );

    // Non-vacuity: the corpus really did contain report→retain flips.
    expect(flipsObserved).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // `bytes` never influences the action.
  // -------------------------------------------------------------------------
  it('derives the disposition independently of facts.bytes', () => {
    fc.assert(
      fc.property(scenarioArb, bytesArb, bytesArb, ({ facts, context }, first, second) => {
        const a = decideObjectDisposition({ ...facts, bytes: first }, context);
        const b = decideObjectDisposition({ ...facts, bytes: second }, context);
        expect(a).toEqual(b);
        // And equal to the disposition with no size at all, so an unreadable size
        // cannot become a deletion input.
        expect(decideObjectDisposition({ ...facts, bytes: null }, context)).toEqual(a);
      }),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Determinism: same inputs, same verdict.
  // -------------------------------------------------------------------------
  it('is a pure function of (objectPath, lastTouchedMs, retainPaths, graceCutoffMs)', () => {
    fc.assert(
      fc.property(scenarioArb, ({ facts, context }) => {
        const first = decideObjectDisposition(facts, context);
        const second = decideObjectDisposition({ ...facts }, { ...context });
        expect(second).toEqual(first);
        // Neither the facts nor the context are mutated by the call.
        const sizeBefore = context.retainPaths.size;
        decideObjectDisposition(facts, context);
        expect(context.retainPaths.size).toBe(sizeBefore);
      }),
      { numRuns: 200 },
    );
  });
});
