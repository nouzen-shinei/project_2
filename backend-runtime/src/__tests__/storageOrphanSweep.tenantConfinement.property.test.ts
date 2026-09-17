// Feature: storage-sweep-scale-hardening, Property 1: One tenant's failure is confined, counted, and still red
/**
 * Property 1: One tenant's failure is confined, counted, and still red
 * **Validates: Requirements 1.1, 1.4, 1.5, 1.7, 1.9, 1.10, 1.11, 1.12, 1.15, 2.1, 2.2, 10.8, 10.9, 10.12**
 *
 * *For any* tenant list, *any* subset of those tenants made to fail, *any* choice
 * of failure site per tenant (`collectTenantReferenceSet` or the Object_Listing)
 * and *any* thrown value:
 *
 *  - every tenant NOT in the failing subset reaches a listing and has its own
 *    Report_Document written;
 *  - every tenant in the failing subset carries `status: 'failed'` — the exact
 *    string, not `'in_progress'` — is neither `completed` nor `aborted`, and has
 *    quarantined zero objects;
 *  - `tenantFailures` equals the size of the failing subset;
 *  - the exit code is non-zero **iff** the failing subset is non-empty;
 *  - exactly one `runs_total` line and exactly one `tenant_failures_total` line is
 *    emitted per tenant per invocation, and no new metric emits a zero-valued line;
 *  - **no metric label value anywhere in the run equals `'failed'`**, while
 *    `runs_total`'s `outcome` label for a confined failure is `in_progress`;
 *  - two runs over the same list visit the tenants in the same order.
 *
 * ── The two halves of the `'failed'` decision ────────────────────────────────
 *
 * Asserting the status *is* `'failed'` and asserting no label *becomes* `'failed'`
 * are two different failure modes. The first catches an implementation that kept
 * the legacy `'in_progress'`; the second catches one that helpfully renamed the
 * `runs_total` `outcome` label to match the new status value and silently broke a
 * deployed `infra/monitoring/` filter (Req 1.15, 10.12). Both are asserted, on
 * every generated input.
 *
 * ── The exit-code clause is a BICONDITIONAL on purpose ───────────────────────
 *
 * The shipped behaviour already failed a run that could not sweep everything; the
 * risk this property guards is the confinement turning a red run GREEN. So the
 * all-aborted case is generated as its own arm below, once per abort reason across
 * all five, because an abort is a designed safe outcome and must stay green
 * (Req 2.2) — `tenant_scope_violation` most of all, since it is the reason a reader
 * is most tempted to make red and is in fact the Scope_Guard working.
 *
 * The exit code is read through the runner's pure `sweepRunExitCode` seam rather
 * than by mutating `process.exitCode`: a test that left a non-zero
 * `process.exitCode` behind would make the whole jest process exit non-zero even
 * with every test passing, which looks exactly like a broken suite. `afterAll`
 * asserts the run leaked nothing into it.
 *
 * ── No vacuous arms (Req 11.26) ──────────────────────────────────────────────
 *
 * No precondition here is established by catching an exception — the confinement
 * converts the throw into a recorded result, which is precisely the change that
 * makes a `try`/`catch`-gated property go vacuously green. Every arm the generators
 * can select is counted and asserted non-zero after `fc.assert` returns: the empty
 * failing subset, a non-empty one, and each of the two failure sites.
 */

import * as fc from 'fast-check';

import {
  quarantineObject,
  runStorageOrphanSweep,
  tenantReportPath,
  type SweepAbortReason,
} from '../jobs/storageOrphanSweep';
// The runner's exit-code decision, as a value: the biconditional is asserted
// without spawning a process and without touching `process.exitCode`.
import { sweepRunExitCode } from '../jobs/runStorageOrphanSweep';
import { TenantScopeViolation } from '../lib/storageObjectRef';
import {
  BUCKET_NAME,
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  downloadUrl,
  iso,
  sweepConfig,
  type DocData,
  type FakeObject,
} from './support/storageOrphanSweepHarness';

// Importing the runner module for `sweepRunExitCode` must not load
// `backend-runtime/.env` into `process.env`: jest runs the suites of one worker in
// a single process, so that would leak real configuration into every suite
// scheduled after this one. Same mock, same reasoning, as the integration suite.
jest.mock('dotenv/config', () => ({}));

const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
/** Old enough that only a reference can retain it. */
const OLD = iso(NOW - 120 * DAY);

/**
 * Six ids, none a prefix of another, all plain path segments — so a listing prefix
 * built for one cannot match another's objects and the per-tenant failure
 * injection below can key off the prefix unambiguously.
 */
const TENANT_IDS = [
  'tenant_a',
  'tenant_b',
  'tenant_c',
  'tenant_d',
  'tenant_e',
  'tenant_f',
] as const;

const FAILURE_SITES = ['collector', 'listing'] as const;
type FailureSite = (typeof FAILURE_SITES)[number];

/** All five, in the order `SweepAbortReason` declares them. */
const ABORT_REASONS: readonly SweepAbortReason[] = [
  'reference_source_failed',
  'malformed_reference',
  'reference_cap_exceeded',
  'quarantine_cap_reached',
  'tenant_scope_violation',
];

/**
 * The collector's own summary log line, which is the ONE statement in
 * `collectTenantReferenceSet` that sits outside every `try`.
 *
 * ── Why the collector arm is injected here, and nowhere else ─────────────────
 *
 * `collectTenantReferenceSet` is deliberately TOTAL for a source failure: every
 * source body runs inside `runSource`, which converts any thrown value into a
 * `failedSources` entry, and a `failedSources` entry is an ABORT
 * (`reference_source_failed`) rather than a Tenant_Sweep_Failure. So a Firestore or
 * Realtime Database fault cannot make the collector *raise* — by design, and that
 * design is not being changed here.
 *
 * What Requirement 1.5 asks for is that the confinement covers the collector call
 * as well as the listing, and that its site emits the `runs_total` line the
 * collector does not (Req 1.9). That contract is independent of where inside the
 * collector the throw originates, so it is exercised at the only statement that can
 * still produce one. If this string ever stops matching, the injection stops firing
 * and the `collectorSite` vacuity counter below goes to zero and FAILS — the arm
 * degrades loudly rather than silently, which is the whole point of Req 11.25.
 */
const COLLECTOR_SUMMARY_LINE = '[orphan_sweep] references collected';

/** The closed label set `SweepMetricLabels` permits (Req 10.1). */
const LABEL_KEYS = ['tenant_id', 'mode', 'reason', 'outcome', 'abort_reason'] as const;

interface MetricLine {
  metric: string;
  value: number;
  severity: string;
  message: string;
  [key: string]: unknown;
}

let consoleLog: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;
let exitCodeAtStart: typeof process.exitCode;

beforeAll(() => {
  exitCodeAtStart = process.exitCode;
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
  // ── `process.exitCode` hygiene, asserted rather than assumed ───────────────
  //
  // Nothing in this file writes `process.exitCode`; the exit code is read through
  // the runner's pure seam. A leaked non-zero value would make the whole jest
  // process exit non-zero with every test green, so the absence of a leak is
  // asserted here and the original value restored regardless.
  const leaked = process.exitCode;
  process.exitCode = exitCodeAtStart;
  expect(leaked).toBe(exitCodeAtStart);
});

/** Every structured metric line emitted since the spy was last cleared. */
function metricLines(): MetricLine[] {
  const lines: MetricLine[] = [];
  for (const call of consoleLog.mock.calls) {
    const first = call[0];
    if (typeof first !== 'string' || !first.startsWith('{') || !first.includes('"metric"')) continue;
    const parsed = JSON.parse(first) as MetricLine;
    if (typeof parsed.metric === 'string') lines.push(parsed);
  }
  return lines;
}

/** The label VALUES of one metric line — never its `metric`, `message` or `value`. */
function labelValues(line: MetricLine): string[] {
  const values: string[] = [];
  for (const key of LABEL_KEYS) {
    const value = line[key];
    if (typeof value === 'string') values.push(value);
  }
  return values;
}

function aged(objectPath: string, size: number): FakeObject {
  return {
    name: objectPath,
    size,
    timeCreated: OLD,
    updated: OLD,
    metadata: { firebaseStorageDownloadTokens: 'tok-live' },
  };
}

/**
 * One aged orphan and one aged-but-referenced object per tenant, so a completed
 * tenant genuinely moves something in apply mode and a failing tenant's zero moves
 * are a fact about the confinement rather than about an empty bucket.
 */
function fixtureFor(tenantIds: readonly string[]): {
  objects: FakeObject[];
  collections: Record<string, Record<string, DocData>>;
} {
  const objects: FakeObject[] = [];
  const notices: Record<string, DocData> = {};
  for (const tenantId of tenantIds) {
    const kept = `notices/${tenantId}/notice_k_kept.png`;
    objects.push(aged(`notices/${tenantId}/notice_k_orphan.png`, 10), aged(kept, 20));
    notices[`notice_${tenantId}`] = { tenantId, imageUrl: downloadUrl(kept) };
  }
  return { objects, collections: { notices } };
}

/**
 * Install the per-tenant collector failure on the `console.log` spy, leaving every
 * other line a no-op. Returns the spy to its silent implementation on the way out
 * of each generated run so no injection outlives the input that asked for it.
 */
function armCollectorFailures(tenantIds: ReadonlySet<string>): void {
  consoleLog.mockImplementation((...called: unknown[]) => {
    if (called[0] === COLLECTOR_SUMMARY_LINE) {
      const detail = called[1] as { tenantId?: unknown } | undefined;
      if (typeof detail?.tenantId === 'string' && tenantIds.has(detail.tenantId)) {
        throw new Error(`reference collection failed for ${detail.tenantId}`);
      }
    }
    return undefined;
  });
}

describe("Property 1: one tenant's failure is confined, counted, and still red", () => {
  it('records exactly the failing subset as failed, sweeps the rest, and reddens iff something failed', async () => {
    // ── The vacuity guard (Req 11.25) ────────────────────────────────────────
    //
    // How many generated inputs reached each arm, asserted AFTER `fc.assert`
    // returns. An arm reached zero times means this property stopped checking
    // something, and it must say so in red rather than pass quietly.
    const arms = { noFailures: 0, someFailures: 0, collectorSite: 0, listingSite: 0 };

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        // Generated explicitly rather than left to a boolean mask: the empty and
        // full subsets are the two ends of the exit-code biconditional, and a
        // 6-bit mask reaches each of them about once in 64 inputs.
        fc.constantFrom('none', 'all', 'some'),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.array(fc.constantFrom(...FAILURE_SITES), { minLength: 6, maxLength: 6 }),
        async (tenantCount, subsetKind, mask, sites) => {
          const tenantIds = TENANT_IDS.slice(0, tenantCount);
          const failing = new Map<string, FailureSite>();
          tenantIds.forEach((tenantId, index) => {
            const fails = subsetKind === 'all' ? true : subsetKind === 'none' ? false : mask[index];
            if (fails) failing.set(tenantId, sites[index]);
          });
          const collectorFailures = new Set(
            [...failing.entries()].filter(([, site]) => site === 'collector').map(([id]) => id)
          );

          if (failing.size === 0) arms.noFailures += 1;
          else arms.someFailures += 1;
          if (collectorFailures.size > 0) arms.collectorSite += 1;
          if ([...failing.values()].some((site) => site === 'listing')) arms.listingSite += 1;

          const log = createOperationLog();
          const { objects, collections } = fixtureFor(tenantIds);
          const db = createFakeFirestore({ log, collections });
          const bucket = createFakeBucket({
            log,
            objects,
            // Only the PAGED listing: the quota recompute pages without
            // `maxResults`, and failing it would test something else.
            failGetFiles: (call) => {
              if (call.maxResults === undefined || call.prefix === undefined) return undefined;
              const tenantId = call.prefix.split('/')[1];
              return failing.get(tenantId) === 'listing'
                ? new Error(`listing page failed for ${tenantId}`)
                : undefined;
            },
          });

          consoleLog.mockClear();
          armCollectorFailures(collectorFailures);

          // Apply mode with the real mover installed, because "quarantined zero
          // objects" is only a claim in the mode that can move one.
          const result = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log, tree: {} }) as never,
            bucket: bucket as never,
            config: sweepConfig({
              tenantIds: [...tenantIds],
              mode: 'sweep',
              apply: true,
              nowMs: NOW,
            }) as never,
            quarantineObject,
          });
          const lines = metricLines();
          consoleLog.mockImplementation(() => undefined);

          // ── Req 1.10: a deterministic order ─────────────────────────────────
          //
          // Stated against the CONFIGURED order, which is stronger than comparing
          // two runs with each other: two runs both equal to the same list are
          // necessarily equal to one another, and a repeated run therefore reaches
          // the tenants a failed run did not.
          expect(result.tenants.map((tenant) => tenant.tenantId)).toEqual([...tenantIds]);

          // ── Req 1.11 and the biconditional of Req 2.1, 2.2 ──────────────────
          expect(result.tenantFailures).toBe(failing.size);
          expect(sweepRunExitCode(result)).toBe(failing.size > 0 ? 1 : 0);

          const copied = log
            .filter((entry) => entry.method === 'file.copy')
            .map((entry) => entry.target);

          for (const tenant of result.tenants) {
            const site = failing.get(tenant.tenantId);
            const report = db.read(tenantReportPath(tenant.tenantId));

            if (site === undefined) {
              // ── Req 1.4: every remaining tenant is swept ───────────────────
              expect(tenant.status).toBe('completed');
              expect(report).toBeDefined();
              expect(report!.status).toBe('completed');
              // It reached a LISTING, not merely a result.
              expect(
                bucket.getFilesCalls.some(
                  (call) =>
                    call.maxResults !== undefined &&
                    call.prefix?.includes(`/${tenant.tenantId}/`) === true
                )
              ).toBe(true);
              continue;
            }

            // ── Req 1.1, 1.7: the exact string, and neither of the other two ──
            expect(tenant.status).toBe('failed');
            expect(tenant.status).not.toBe('in_progress');
            expect(tenant.status).not.toBe('completed');
            expect(tenant.status).not.toBe('aborted');
            expect(tenant.abortReason).toBeUndefined();
            // Req 1.2, 1.3: the coerced message is recorded and names the failure.
            expect(typeof tenant.failureMessage).toBe('string');
            expect(tenant.failureMessage).toContain(
              site === 'collector' ? 'reference collection failed' : 'listing page failed'
            );

            // ── Req 1.12: zero objects quarantined, as a postcondition ────────
            expect(tenant.quarantinedCount).toBe(0);
            expect(tenant.quarantinedBytes).toBe(0);
            expect(copied.filter((path) => path.includes(`/${tenant.tenantId}/`))).toEqual([]);

            if (site === 'collector') {
              // The collector site reaches no listing and writes no report, so
              // this tenant's Report_Document keeps whatever a previous run left —
              // nothing, here (Req 1.6's asymmetry).
              expect(report).toBeUndefined();
              expect(
                bucket.getFilesCalls.filter(
                  (call) => call.prefix?.includes(`/${tenant.tenantId}/`) === true
                )
              ).toEqual([]);
            } else {
              // The listing site's report is `sweepTenant`'s own diagnostic write:
              // `status` and `lastError`, with the previous cursor standing.
              expect(report).toBeDefined();
              expect(report!.status).toBe('failed');
              expect(typeof report!.lastError).toBe('string');
            }
          }

          // ── Req 1.9, 10.8, 10.9: the metric surface, line by line ────────────
          for (const tenantId of tenantIds) {
            const runsLines = lines.filter(
              (line) =>
                line.metric === 'storage_orphan_sweep_runs_total' && line.tenant_id === tenantId
            );
            expect(runsLines).toHaveLength(1);

            const failureLines = lines.filter(
              (line) =>
                line.metric === 'storage_orphan_sweep_tenant_failures_total' &&
                line.tenant_id === tenantId
            );
            expect(failureLines).toHaveLength(failing.has(tenantId) ? 1 : 0);

            if (failing.has(tenantId)) {
              // ── DO NOT "FIX" THIS TO 'failed' ────────────────────────────────
              //
              // The recorded status and the Report_Document both say `'failed'`;
              // the deployed metric label does not follow them, because
              // `infra/monitoring/` cannot be updated transactionally with a
              // deploy (Req 1.15, 10.12).
              expect(runsLines[0].outcome).toBe('in_progress');
            } else {
              expect(runsLines[0].outcome).toBe('completed');
            }
          }

          // No new metric emits a zero-valued line (Req 10.9).
          for (const line of lines) {
            if (line.metric !== 'storage_orphan_sweep_tenant_failures_total') continue;
            expect(line.value).toBe(1);
          }

          // ── The other half of the `'failed'` decision (Req 1.15, 10.12) ──────
          //
          // No metric label value ANYWHERE in the run equals `'failed'`, whatever
          // the statuses say.
          for (const line of lines) {
            expect(labelValues(line)).not.toContain('failed');
            expect(Object.keys(line).filter((key) => !LABEL_KEYS.includes(key as never))).toEqual([
              'severity',
              'message',
              'metric',
              'value',
            ]);
          }
        }
      ),
      { numRuns: 100 }
    );

    expect(arms.noFailures).toBeGreaterThan(0);
    expect(arms.someFailures).toBeGreaterThan(0);
    expect(arms.collectorSite).toBeGreaterThan(0);
    expect(arms.listingSite).toBeGreaterThan(0);
  });

  /**
   * ── The all-aborted arm, once per abort reason ─────────────────────────────
   *
   * Enumerated with `it.each` rather than generated with `fc.constantFrom`, so
   * every one of the five is reached on every execution of this suite rather than
   * with high probability — which is what makes "for every one of the five abort
   * reasons alike" (Req 2.2) an assertion rather than a sampling claim. The tenant
   * count and the fixture shape stay generated inside each case.
   */
  describe('a run in which every tenant aborted exits ZERO', () => {
    it.each([...ABORT_REASONS])('for abort reason %s', async (reason) => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (tenantCount) => {
          const tenantIds = TENANT_IDS.slice(0, tenantCount);
          const log = createOperationLog();
          const objects: FakeObject[] = [];
          const notices: Record<string, DocData> = {};
          for (const tenantId of tenantIds) {
            objects.push(
              aged(`notices/${tenantId}/notice_k_a.png`, 10),
              aged(`notices/${tenantId}/notice_k_b.png`, 20)
            );
            if (reason === 'malformed_reference') {
              notices[`bad_${tenantId}`] = {
                tenantId,
                imageUrl: `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/%zz`,
              };
            } else {
              // Two references, so a ceiling of 1 is breached by the set rather
              // than by a single entry.
              notices[`one_${tenantId}`] = {
                tenantId,
                imageUrl: downloadUrl(`notices/${tenantId}/notice_k_ref_1.png`),
              };
              notices[`two_${tenantId}`] = {
                tenantId,
                imageUrl: downloadUrl(`notices/${tenantId}/notice_k_ref_2.png`),
              };
            }
          }

          const db = createFakeFirestore({ log, collections: { notices } });
          const bucket = createFakeBucket({ log, objects });
          consoleLog.mockClear();

          const result = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({
              log,
              tree: {},
              // Source 1 unreadable ⇒ `failedSources` ⇒ `reference_source_failed`.
              ...(reason === 'reference_source_failed'
                ? { failure: { value: new Error('PERMISSION_DENIED') } }
                : {}),
            }) as never,
            bucket: bucket as never,
            config: sweepConfig({
              tenantIds: [...tenantIds],
              nowMs: NOW,
              // The last two arise during Phase 2, so they need a mode that moves.
              ...(reason === 'quarantine_cap_reached' || reason === 'tenant_scope_violation'
                ? { mode: 'sweep', apply: true }
                : {}),
              ...(reason === 'reference_cap_exceeded' ? { maxReferences: 1 } : {}),
              ...(reason === 'quarantine_cap_reached' ? { maxQuarantinePerTenant: 1 } : {}),
            }) as never,
            ...(reason === 'tenant_scope_violation'
              ? {
                  // The guard is unreachable through the Decision_Function, so the
                  // violation is injected: what is asserted is that the run stays
                  // GREEN, because this is the Scope_Guard working.
                  quarantineObject: async () => {
                    throw new TenantScopeViolation('notices/other/x.png', 'other', 'tenant_mismatch');
                  },
                }
              : reason === 'quarantine_cap_reached'
                ? { quarantineObject }
                : {}),
          });
          const lines = metricLines();

          for (const tenant of result.tenants) {
            expect(tenant.status).toBe('aborted');
            expect(tenant.abortReason).toBe(reason);
          }
          // An abort is a designed safe outcome: nothing failed, so nothing is red.
          expect(result.tenantFailures).toBe(0);
          expect(sweepRunExitCode(result)).toBe(0);
          expect(
            lines.filter((line) => line.metric === 'storage_orphan_sweep_tenant_failures_total')
          ).toEqual([]);
          for (const line of lines) {
            expect(labelValues(line)).not.toContain('failed');
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
