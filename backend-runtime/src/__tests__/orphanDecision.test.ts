/**
 * Feature: storage-orphan-cleanup — task 2.2 unit tests for the decision function.
 *
 * `decideObjectDisposition` is the one place "is this object an orphan?" is
 * answered, and `action: 'report'` is the only disposition that can lead to a
 * byte being moved. The five worked examples from `design.md`'s Example Usage are
 * reproduced below as the readable spine — they are the shortest complete
 * statement of the rule — and the remaining blocks pin the edges that the
 * examples do not reach: the grace boundary to the millisecond, every unusable
 * `lastTouchedMs` shape, the quarantine namespace, and the arithmetic of
 * `computeGraceCutoffMs`.
 *
 * Pure jest: no Express app, no Firebase Admin, no bucket, no clock — the same
 * posture as `uploadObjectPath.test.ts` and `storageObjectRef.test.ts`.
 *
 * _Requirements: 18.8_
 */
import {
  DAY_MS,
  DEFAULT_GRACE_DAYS,
  DEFAULT_QUARANTINE_RETENTION_DAYS,
  computeGraceCutoffMs,
  decideObjectDisposition,
} from '../lib/orphanDecision';
import type { DecisionContext, ObjectDisposition, ObjectFacts } from '../lib/orphanDecision';
import { QUARANTINE_PREFIX, STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';

// ---------------------------------------------------------------------------
// The fixture from `design.md`'s "Using the pure decision function directly".
// ---------------------------------------------------------------------------
const NOW = Date.parse('2026-04-01T00:00:00Z');
const TENANT = 'acme';
const REFERENCED_PATH = 'receipts/acme/fee_1/k_aaaa_a.pdf';

const CONTEXT: DecisionContext = {
  tenantId: TENANT,
  retainPaths: new Set([REFERENCED_PATH]),
  graceCutoffMs: computeGraceCutoffMs(NOW, 7),
};

/** `ObjectFacts` with the reporting-irrelevant `bytes` defaulted. */
function facts(objectPath: string, lastTouchedMs: number | null, bytes: number | null = 10): ObjectFacts {
  return { objectPath, lastTouchedMs, bytes };
}

function decide(objectPath: string, lastTouchedMs: number | null, context = CONTEXT): ObjectDisposition {
  return decideObjectDisposition(facts(objectPath, lastTouchedMs), context);
}

const RETAINED: ObjectDisposition['reason'][] = [
  'referenced',
  'within_grace',
  'age_unknown',
  'unmanaged_path',
  'quarantine_path',
];

// ---------------------------------------------------------------------------
// The five worked examples, verbatim from the design.
// ---------------------------------------------------------------------------
describe('decideObjectDisposition: the five worked examples from the design', () => {
  it('1. referenced and 400 days old → retain/referenced', () => {
    // References win over age unconditionally: an old object someone still points
    // at is not an orphan, it is an old file.
    expect(decide(REFERENCED_PATH, NOW - 400 * DAY_MS)).toEqual({
      action: 'retain',
      reason: 'referenced',
    });
  });

  it('2. unreferenced but 2 days old → retain/within_grace', () => {
    // The non-atomic gap between storing bytes and writing the record.
    expect(decide('receipts/acme/fee_2/k_bbbb_b.pdf', NOW - 2 * DAY_MS)).toEqual({
      action: 'retain',
      reason: 'within_grace',
    });
  });

  it('3. unreferenced with lastTouchedMs null → retain/age_unknown', () => {
    // Cannot prove it is old, therefore cannot prove it is an orphan.
    expect(decide('receipts/acme/fee_3/k_cccc_c.pdf', null)).toEqual({
      action: 'retain',
      reason: 'age_unknown',
    });
  });

  it("4. another tenant's path → retain/unmanaged_path", () => {
    // Never ours to judge, whatever its age or reference status.
    expect(decide('receipts/other/fee_4/k_dddd_d.pdf', NOW - 90 * DAY_MS)).toEqual({
      action: 'retain',
      reason: 'unmanaged_path',
    });
  });

  it('5. in scope, unreferenced, provably old → report/unreferenced', () => {
    // The ONLY reporting case in the whole function.
    expect(decide('receipts/acme/fee_5/k_eeee_e.pdf', NOW - 90 * DAY_MS)).toEqual({
      action: 'report',
      reason: 'unreferenced',
    });
  });
});

// ---------------------------------------------------------------------------
// Branch order: scope → quarantine → referenced → grace → age.
// ---------------------------------------------------------------------------
describe('decideObjectDisposition: the documented branch order', () => {
  it('decides scope before reference membership', () => {
    // A cross-tenant path that IS in the retain set still reads `unmanaged_path`:
    // scope is settled before `retainPaths` is consulted, so a stale cross-tenant
    // reference can never make another tenant's object look like ours to judge.
    const context: DecisionContext = {
      ...CONTEXT,
      retainPaths: new Set(['receipts/other/fee_4/k_dddd_d.pdf']),
    };
    expect(decide('receipts/other/fee_4/k_dddd_d.pdf', NOW - 90 * DAY_MS, context)).toEqual({
      action: 'retain',
      reason: 'unmanaged_path',
    });
  });

  it('decides reference membership before the grace comparison', () => {
    // Same object, both branches applicable: `referenced` is the honest reason.
    expect(decide(REFERENCED_PATH, NOW - 1 * DAY_MS)).toEqual({
      action: 'retain',
      reason: 'referenced',
    });
  });

  it('decides reference membership before age availability', () => {
    // A referenced object with unreadable metadata reports `referenced`, not
    // `age_unknown` — the reason an operator reads should be the informative one.
    expect(decide(REFERENCED_PATH, null)).toEqual({ action: 'retain', reason: 'referenced' });
    expect(decide(REFERENCED_PATH, Number.NaN)).toEqual({ action: 'retain', reason: 'referenced' });
  });

  it('decides the grace comparison before age availability', () => {
    // Within grace and usable → `within_grace`; unusable → `age_unknown`.
    expect(decide('receipts/acme/fee_6/x.pdf', NOW).reason).toBe('within_grace');
    expect(decide('receipts/acme/fee_6/x.pdf', null).reason).toBe('age_unknown');
  });

  it.each(STORAGE_TENANT_CATEGORIES)('reports a provably old unreferenced object under %s', (category) => {
    expect(decide(`${category}/${TENANT}/object.bin`, NOW - 90 * DAY_MS)).toEqual({
      action: 'report',
      reason: 'unreferenced',
    });
  });

  it('retains a seventh, unmanaged category as unmanaged_path', () => {
    expect(decide(`invoices/${TENANT}/march.pdf`, NOW - 90 * DAY_MS)).toEqual({
      action: 'retain',
      reason: 'unmanaged_path',
    });
  });

  it('retains a too-shallow path as unmanaged_path', () => {
    for (const objectPath of ['receipts/acme', 'receipts/acme/', 'receipts', '']) {
      expect(decide(objectPath, NOW - 90 * DAY_MS)).toEqual({
        action: 'retain',
        reason: 'unmanaged_path',
      });
    }
  });

  it('retains a prefix-colliding tenant path in both directions', () => {
    // `acme` must not reach `acme-2`, nor the reverse.
    expect(decide('receipts/acme-2/x.pdf', NOW - 90 * DAY_MS).reason).toBe('unmanaged_path');
    const acme2: DecisionContext = { ...CONTEXT, tenantId: 'acme-2' };
    expect(decide('receipts/acme/x.pdf', NOW - 90 * DAY_MS, acme2).reason).toBe('unmanaged_path');
    expect(decide('receipts/acme-2/x.pdf', NOW - 90 * DAY_MS, acme2)).toEqual({
      action: 'report',
      reason: 'unreferenced',
    });
  });
});

// ---------------------------------------------------------------------------
// The quarantine namespace.
// ---------------------------------------------------------------------------
describe('decideObjectDisposition: paths under QUARANTINE_PREFIX', () => {
  // `QUARANTINE_PREFIX` is deliberately NOT a managed category, so a quarantine
  // path has already failed the scope test by the time it is recognised. The
  // quarantine branch therefore refines the REASON from `unmanaged_path` to
  // `quarantine_path`; it never changes the action, which is `retain` either way.
  // That is the only reading under which both Req 1.6 and Req 1.7 are reachable,
  // and it is what the module documents.
  it('retains a quarantined live path as quarantine_path', () => {
    const quarantined = `${QUARANTINE_PREFIX}/${TENANT}/sweep_1700000000000_ab12cd/${REFERENCED_PATH}`;
    expect(decide(quarantined, NOW - 400 * DAY_MS)).toEqual({
      action: 'retain',
      reason: 'quarantine_path',
    });
  });

  it('retains every shape inside the quarantine namespace, at any age', () => {
    for (const objectPath of [
      QUARANTINE_PREFIX,
      `${QUARANTINE_PREFIX}/`,
      `${QUARANTINE_PREFIX}/${TENANT}`,
      `${QUARANTINE_PREFIX}/${TENANT}/sweep_1`,
      `${QUARANTINE_PREFIX}/${TENANT}/sweep_1/receipts/${TENANT}/x.pdf`,
      `${QUARANTINE_PREFIX}/other/sweep_1/receipts/other/x.pdf`,
    ]) {
      for (const lastTouchedMs of [null, NOW, NOW - 400 * DAY_MS, Number.NaN]) {
        expect(decide(objectPath, lastTouchedMs)).toEqual({
          action: 'retain',
          reason: 'quarantine_path',
        });
      }
    }
  });

  it('retains a quarantined path that is also in the retain set as quarantine_path', () => {
    // Quarantine is settled before `retainPaths`, so a manifest path that leaked
    // into the retain set cannot change the reason.
    const quarantined = `${QUARANTINE_PREFIX}/${TENANT}/sweep_1/receipts/${TENANT}/x.pdf`;
    const context: DecisionContext = { ...CONTEXT, retainPaths: new Set([quarantined]) };
    expect(decide(quarantined, NOW - 400 * DAY_MS, context)).toEqual({
      action: 'retain',
      reason: 'quarantine_path',
    });
  });

  it('does not mistake a sibling of the quarantine prefix for the quarantine namespace', () => {
    // Tested at the segment boundary, not by a raw `startsWith`: both retain, but
    // the reason is what an operator reads on the report.
    expect(decide(`${QUARANTINE_PREFIX}-old/${TENANT}/x.pdf`, NOW - 400 * DAY_MS)).toEqual({
      action: 'retain',
      reason: 'unmanaged_path',
    });
    expect(decide(`${QUARANTINE_PREFIX}2/${TENANT}/x.pdf`, NOW - 400 * DAY_MS)).toEqual({
      action: 'retain',
      reason: 'unmanaged_path',
    });
  });
});

// ---------------------------------------------------------------------------
// The grace boundary, to the millisecond.
// ---------------------------------------------------------------------------
describe('decideObjectDisposition: the grace boundary', () => {
  const CUTOFF = CONTEXT.graceCutoffMs;
  const UNREFERENCED = 'receipts/acme/fee_boundary/k_ffff_f.pdf';

  it('retains an object touched exactly AT the cutoff', () => {
    // The comparison is strict (`lastTouchedMs < graceCutoffMs`), matching the
    // documented strictness of `isStaleForPrune` in `jobs/offlineDevicePrune.ts`.
    // At the boundary the safe direction is to retain.
    expect(decide(UNREFERENCED, CUTOFF)).toEqual({ action: 'retain', reason: 'within_grace' });
  });

  it('retains an object touched one millisecond AFTER the cutoff', () => {
    expect(decide(UNREFERENCED, CUTOFF + 1)).toEqual({ action: 'retain', reason: 'within_grace' });
  });

  it('reports an object touched one millisecond BEFORE the cutoff', () => {
    expect(decide(UNREFERENCED, CUTOFF - 1)).toEqual({ action: 'report', reason: 'unreferenced' });
  });

  it('places the boundary exactly graceDays before the injected now', () => {
    expect(CUTOFF).toBe(NOW - DEFAULT_GRACE_DAYS * DAY_MS);
    // The oldest reported age and the youngest retained age differ by 1 ms.
    expect(decide(UNREFERENCED, NOW - DEFAULT_GRACE_DAYS * DAY_MS - 1).action).toBe('report');
    expect(decide(UNREFERENCED, NOW - DEFAULT_GRACE_DAYS * DAY_MS).action).toBe('retain');
  });

  it('retains at the boundary for every configured graceDays', () => {
    for (const graceDays of [1, 7, 365]) {
      const context: DecisionContext = { ...CONTEXT, graceCutoffMs: computeGraceCutoffMs(NOW, graceDays) };
      expect(decide(UNREFERENCED, context.graceCutoffMs, context).reason).toBe('within_grace');
      expect(decide(UNREFERENCED, context.graceCutoffMs + 1, context).reason).toBe('within_grace');
      expect(decide(UNREFERENCED, context.graceCutoffMs - 1, context)).toEqual({
        action: 'report',
        reason: 'unreferenced',
      });
    }
  });

  it('retains rather than reports when the injected cutoff is itself unusable', () => {
    // `lastTouchedMs < NaN` is false, so the grace branch treats "not provably
    // older" as within grace — the safe direction for a mis-computed cutoff.
    const nanCutoff: DecisionContext = { ...CONTEXT, graceCutoffMs: Number.NaN };
    expect(decide(UNREFERENCED, NOW - 400 * DAY_MS, nanCutoff)).toEqual({
      action: 'retain',
      reason: 'within_grace',
    });
    const pastCutoff: DecisionContext = { ...CONTEXT, graceCutoffMs: 0 };
    expect(decide(UNREFERENCED, NOW - 400 * DAY_MS, pastCutoff)).toEqual({
      action: 'retain',
      reason: 'within_grace',
    });
  });
});

// ---------------------------------------------------------------------------
// Every unusable `lastTouchedMs` shape.
// ---------------------------------------------------------------------------
describe('decideObjectDisposition: lastTouchedMs shapes', () => {
  const UNREFERENCED = 'receipts/acme/fee_age/k_1111_1.pdf';

  it('retains as age_unknown when the field is absent altogether', () => {
    // The collector types it `number | null`, but the value arrives from
    // `file.metadata` and an absent field is exactly what an unreadable object
    // looks like.
    const absent = { objectPath: UNREFERENCED, bytes: 10 } as unknown as ObjectFacts;
    expect(decideObjectDisposition(absent, CONTEXT)).toEqual({
      action: 'retain',
      reason: 'age_unknown',
    });
    const undefinedValue = {
      objectPath: UNREFERENCED,
      lastTouchedMs: undefined,
      bytes: 10,
    } as unknown as ObjectFacts;
    expect(decideObjectDisposition(undefinedValue, CONTEXT)).toEqual({
      action: 'retain',
      reason: 'age_unknown',
    });
  });

  it.each([
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-1', -1],
    ['a large negative value', -1_700_000_000_000],
  ])('retains as age_unknown for lastTouchedMs %s', (_label, lastTouchedMs) => {
    expect(decide(UNREFERENCED, lastTouchedMs as number | null)).toEqual({
      action: 'retain',
      reason: 'age_unknown',
    });
  });

  it('retains a far-future lastTouchedMs as within_grace', () => {
    // A clock-skewed object reads as young, which is the retention-safe direction.
    for (const lastTouchedMs of [NOW + 1, NOW + 400 * DAY_MS, 8_640_000_000_000_000]) {
      expect(decide(UNREFERENCED, lastTouchedMs)).toEqual({
        action: 'retain',
        reason: 'within_grace',
      });
    }
  });

  it('treats epoch zero as a usable, provably old timestamp', () => {
    // `0` is a real instant, distinct from absent — and older than any cutoff a
    // positive `graceDays` can produce from a present-day `nowMs`.
    expect(decide(UNREFERENCED, 0)).toEqual({ action: 'report', reason: 'unreferenced' });
  });

  it('retains as age_unknown for a non-numeric value that slipped past the type', () => {
    for (const value of ['1700000000000', {}, [], true]) {
      const hostile = { objectPath: UNREFERENCED, lastTouchedMs: value, bytes: 10 } as unknown as ObjectFacts;
      expect(decideObjectDisposition(hostile, CONTEXT)).toEqual({
        action: 'retain',
        reason: 'age_unknown',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Totality, and the irrelevance of `bytes`.
// ---------------------------------------------------------------------------
describe('decideObjectDisposition: totality', () => {
  it('never lets bytes influence the disposition', () => {
    const paths = [
      REFERENCED_PATH,
      'receipts/acme/fee_bytes/k_2222_2.pdf',
      'receipts/other/fee_bytes/k_3333_3.pdf',
      `${QUARANTINE_PREFIX}/${TENANT}/sweep_1/receipts/${TENANT}/x.pdf`,
    ];
    const ages = [null, NOW, NOW - 400 * DAY_MS, Number.NaN];
    const byteValues = [null, 0, -1, 1, 1024, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER];

    for (const objectPath of paths) {
      for (const lastTouchedMs of ages) {
        const baseline = decideObjectDisposition(facts(objectPath, lastTouchedMs, null), CONTEXT);
        for (const bytes of byteValues) {
          expect(decideObjectDisposition(facts(objectPath, lastTouchedMs, bytes), CONTEXT)).toEqual(baseline);
        }
      }
    }
  });

  it('returns a declared disposition and never throws for a non-string objectPath', () => {
    for (const objectPath of [null, undefined, 42, {}, []]) {
      const hostile = { objectPath, lastTouchedMs: NOW - 400 * DAY_MS, bytes: 1 } as unknown as ObjectFacts;
      expect(decideObjectDisposition(hostile, CONTEXT)).toEqual({
        action: 'retain',
        reason: 'unmanaged_path',
      });
    }
  });

  it('returns one of the six declared reasons for every disposition it produces', () => {
    const disposition = decide('receipts/acme/fee_5/k_eeee_e.pdf', NOW - 90 * DAY_MS);
    expect(disposition.action === 'report' ? ['unreferenced'] : RETAINED).toContain(disposition.reason);
  });
});

// ---------------------------------------------------------------------------
// `computeGraceCutoffMs`.
// ---------------------------------------------------------------------------
describe('computeGraceCutoffMs', () => {
  it.each([
    [1, 86_400_000],
    [7, 604_800_000],
    [365, 31_536_000_000],
  ])('subtracts %i day(s) as %i ms', (graceDays, expectedDelta) => {
    expect(computeGraceCutoffMs(NOW, graceDays)).toBe(NOW - expectedDelta);
    expect(NOW - computeGraceCutoffMs(NOW, graceDays)).toBe(expectedDelta);
    expect(computeGraceCutoffMs(NOW, graceDays)).toBeLessThan(NOW);
  });

  it('is plain arithmetic with no clamping or defaulting', () => {
    // A non-finite or non-positive `graceDays` falls back to the default in the
    // RUNNER, where configuration is parsed; this function stays the arithmetic
    // its postcondition says it is.
    expect(computeGraceCutoffMs(NOW, 0)).toBe(NOW);
    expect(computeGraceCutoffMs(NOW, -1)).toBe(NOW + DAY_MS);
    expect(computeGraceCutoffMs(0, 7)).toBe(-7 * DAY_MS);
    expect(Number.isNaN(computeGraceCutoffMs(NOW, Number.NaN))).toBe(true);
    expect(computeGraceCutoffMs(NOW, 0.5)).toBe(NOW - DAY_MS / 2);
  });

  it('is strictly decreasing in graceDays', () => {
    const cutoffs = [1, 2, 7, 30, 365].map((graceDays) => computeGraceCutoffMs(NOW, graceDays));
    for (let i = 1; i < cutoffs.length; i += 1) {
      expect(cutoffs[i]).toBeLessThan(cutoffs[i - 1]);
    }
  });

  it('exposes the documented constants', () => {
    expect(DAY_MS).toBe(86_400_000);
    expect(DEFAULT_GRACE_DAYS).toBe(7);
    expect(DEFAULT_QUARANTINE_RETENTION_DAYS).toBe(7);
  });
});
