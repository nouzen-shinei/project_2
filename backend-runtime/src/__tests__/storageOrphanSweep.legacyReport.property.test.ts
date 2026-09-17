// Feature: storage-sweep-scale-hardening, Property 11: A Report_Document written by the shipped code always resumes, and so does one recording 'failed'
/**
 * **Validates: Requirements 1.13, 1.14, 9.1, 9.2, 9.3, 9.4, 9.5, 9.9, 9.12, 9.13, 9.14, 9.15**
 *
 * *For any* Report_Document assembled in the **shipped** field shape — with *any*
 * subset of this spec's new fields absent, *any* set of unknown `retainedByReason`
 * keys, *any* non-negative counter values including combinations that violate the
 * current accounting identity **in absolute terms**, and *any* resume cursor of the
 * shape `{ prefixIndex, pageToken }` including an out-of-range `prefixIndex` — a
 * resume returns a `TenantSweepResult` without throwing, and the **delta** accounting
 * identity holds for the pages this process examined.
 *
 * And *for any* recorded status drawn from `'in_progress'`, `'failed'`,
 * `'completed'`, an absent field, a non-string value and an unrecognised string, with
 * `force` false:
 *
 *  - the resume returns a result without throwing (Req 9.13);
 *  - the persisted cursor and the persisted counters are **inherited** — asserted by
 *    comparing the resumed run's starting prefix and page token against the recorded
 *    ones and its final counters against `recorded + examined-by-this-process`, so a
 *    status value that fell through to a restart-from-scratch branch **fails**
 *    (Reqs 1.13, 1.14);
 *  - the tenant **is** re-listed for every status except `'completed'`, and the
 *    `'completed'` arm returns the recorded result **without re-listing** (Reqs 9.9,
 *    1.14);
 *  - a document recording `'failed'` is read by an assertion helper modelling a
 *    **status-unaware reader**: every other field parses and the document is not
 *    rejected as invalid (Req 9.15).
 *
 * ── Why `'failed'` is grouped with the absent and unrecognised cases ───────────
 *
 * Deliberately, and it is the whole point of the arm. It asserts that `'failed'` gets
 * its resume behaviour from the **default-to-resume** path rather than from a special
 * case — which is the only version of Req 1.13 that stays true after someone adds a
 * sixth status value. `'completed'` is generated alongside them so the clause is a
 * discrimination rather than a tautology: the early return has to fire for exactly one
 * of the six.
 *
 * The corresponding hazard, and the door this property holds shut: any future edit
 * that rewrites one of the three resume read sites — the `force`-false early return,
 * `freshStart`, `countersFromProgress` — into an *inequality against `'in_progress'`*
 * would read a `'failed'` document as recorded-and-done and skip that tenant forever.
 * All three currently test **equality with `'completed'`**, which is why the widening
 * was additive for free and why this file is a regression test rather than a
 * companion to an edit.
 *
 * ── Preconditions come from recorded values, never from a catch (Req 11.26) ────
 *
 * There is no `try`/`catch` anywhere below. "The resume did not throw" is asserted by
 * *executing* it — a throw fails the test — and every arm is selected from the
 * generated recorded status and the returned result, both of which exist whether or
 * not anything was thrown.
 */

import * as fc from 'fast-check';

import { STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';
import {
  RETAIN_REASONS,
  listingPrefixesForTenant,
  runStorageOrphanSweep,
  tenantReportPath,
  type RetainReason,
} from '../jobs/storageOrphanSweep';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  downloadUrl,
  iso,
  sweepConfig,
  type DocData,
  type FakeObject,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
const OLD = iso(NOW - 120 * DAY);
const PAGE_SIZE = 2;
const PREFIXES = listingPrefixesForTenant(TENANT);

/**
 * Three aged objects in EVERY Managed_Category, so any in-range `prefixIndex` names a
 * prefix with something left to list and the "continued from the cursor" clause is a
 * claim about an actual continuation rather than about an empty prefix.
 *
 * Plus one referenced object, so the Reference_Fingerprint the resume is checked
 * against is a real one rather than the fingerprint of an empty set — a stale
 * fingerprint discards the cursor (Req 9.12), which would make every inheritance
 * assertion below vacuously false for the wrong reason.
 */
const REFERENCED = `notices/${TENANT}/notice_k_live.png`;

function fixtureObjects(): FakeObject[] {
  const objects: FakeObject[] = [];
  for (const category of STORAGE_TENANT_CATEGORIES) {
    for (const index of [0, 1, 2]) {
      objects.push({
        name: `${category}/${TENANT}/obj_${index}.bin`,
        size: 10 + index,
        timeCreated: OLD,
        updated: OLD,
      });
    }
  }
  objects.push({ name: REFERENCED, size: 5, timeCreated: OLD, updated: OLD });
  return objects;
}

const COLLECTIONS: Record<string, Record<string, DocData>> = {
  notices: { notice_live: { tenantId: TENANT, imageUrl: downloadUrl(REFERENCED) } },
};

/** Object names the PAGED listing returned, i.e. the objects this process examined. */
function examinedNames(log: OperationLog): string[] {
  const names: string[] = [];
  for (const entry of log.entries) {
    if (entry.method !== 'getFiles.page' || entry.detail?.maxResults === null) continue;
    for (const name of (entry.detail?.names ?? []) as string[]) names.push(name);
  }
  return names;
}

/**
 * `toNonNegativeInt`'s rule, restated INDEPENDENTLY here rather than imported.
 *
 * It is not exported, and importing it would be the wrong move anyway: a test that
 * computes its expectation by calling the implementation asserts nothing. This is the
 * oracle — `Number(value)`, then finite-and-strictly-positive, then `Math.trunc`, and
 * `0` for everything else.
 */
function coerceCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

interface InheritedCounters {
  objectsScanned: number;
  orphanCount: number;
  orphanBytes: number;
  quarantinedCount: number;
  quarantineFailures: number;
  fieldReferencesObserved: number;
  retainedByReason: Record<RetainReason, number>;
}

/** What `countersFromProgress` must inherit from a recorded document. */
function inheritedFrom(recorded: DocData): InheritedCounters {
  const recordedReasons = (recorded.retainedByReason ?? {}) as Record<string, unknown>;
  const retainedByReason = {} as Record<RetainReason, number>;
  for (const reason of RETAIN_REASONS) {
    // Seeded from the KNOWN reason set and overlaid with the recorded value, so an
    // unknown recorded key contributes nothing and a missing known key is 0.
    retainedByReason[reason] = coerceCount(recordedReasons[reason]);
  }
  return {
    objectsScanned: coerceCount(recorded.objectsScanned),
    orphanCount: coerceCount(recorded.orphanCount),
    orphanBytes: coerceCount(recorded.orphanBytes),
    quarantinedCount: coerceCount(recorded.quarantinedCount),
    quarantineFailures: coerceCount(recorded.quarantineFailures),
    fieldReferencesObserved: coerceCount(recorded.fieldReferencesObserved),
    retainedByReason,
  };
}

/**
 * A reader that predates `'failed'` (Req 9.15).
 *
 * Models exactly the situation a rolling deploy produces: an older revision, an
 * operator's script or the Firestore console reading a document whose `status` carries
 * a value outside its own union. `status` is a plain string and nothing validates it as
 * an enum before parsing the rest, so the outcome is an **unrecognised status**, not an
 * unreadable document — and, notably, such a reader falls into its own
 * non-`'completed'` branch and resumes the tenant from its cursor, which is correct
 * behaviour arrived at by not recognising the value.
 */
const STATUSES_A_PREDATING_READER_KNOWS = ['completed', 'aborted', 'in_progress'] as const;

interface StatusUnawareRead {
  recognisedStatus: string | null;
  unrecognisedStatus: string | null;
  wouldResume: boolean;
  resume: { prefixIndex: number; pageToken: string | null } | null;
  objectsScanned: number;
  referenceFingerprint: string | null;
  fieldCount: number;
}

function readAsPredatingReader(document: DocData): StatusUnawareRead {
  const status = typeof document.status === 'string' ? document.status : null;
  const recognised =
    status !== null && (STATUSES_A_PREDATING_READER_KNOWS as readonly string[]).includes(status);
  const recordedResume = document.resume as Record<string, unknown> | null | undefined;
  return {
    recognisedStatus: recognised ? status : null,
    unrecognisedStatus: status !== null && !recognised ? status : null,
    // The default-to-resume reading every version of this code has: only
    // `'completed'` means "do not re-sweep".
    wouldResume: status !== 'completed',
    resume:
      recordedResume === null || recordedResume === undefined
        ? null
        : {
            prefixIndex: coerceCount(recordedResume.prefixIndex),
            pageToken:
              typeof recordedResume.pageToken === 'string' ? recordedResume.pageToken : null,
          },
    objectsScanned: coerceCount(document.objectsScanned),
    referenceFingerprint:
      typeof document.referenceFingerprint === 'string' ? document.referenceFingerprint : null,
    fieldCount: Object.keys(document).length,
  };
}

/**
 * The new Report_Document fields this spec adds, so a generated subset of them can be
 * present and the rest ABSENT — which is the shape a document written by the shipped
 * code has: none of them at all (Req 9.2, 9.6).
 */
const NEW_ROOT_FIELDS = ['pagesBySource', 'capBreach', 'reportWrites', 'leaseToken'] as const;
const NEW_PARAM_FIELDS = [
  'firestorePageSize',
  'reportWritePages',
  'reportWriteMs',
  'quarantineWriteThreshold',
  'footprintEstimateBytes',
  'heapLimitBytes',
] as const;

function newRootValue(field: (typeof NEW_ROOT_FIELDS)[number]): unknown {
  switch (field) {
    case 'pagesBySource':
      return { notices: 1 };
    case 'capBreach':
      return null;
    case 'reportWrites':
      return 3;
    case 'leaseToken':
      return 'lease-token-abc';
  }
}

interface LegacyDocInput {
  status: 'in_progress' | 'failed' | 'completed' | 'absent' | 'non_string' | 'unrecognised';
  presentRootFields: (typeof NEW_ROOT_FIELDS)[number][];
  presentParamFields: (typeof NEW_PARAM_FIELDS)[number][];
  unknownReasons: string[];
  prefixIndex: number;
  tokenKind: 'none' | 'well_formed' | 'garbage';
  objectsScanned: number;
  orphanCount: number;
  quarantinedCount: number;
  quarantineFailures: number;
  retained: number[];
}

/** The recorded status as it lands on the document; `undefined` ⇒ the field is absent. */
function recordedStatusValue(kind: LegacyDocInput['status']): unknown {
  switch (kind) {
    case 'absent':
      return undefined;
    case 'non_string':
      return 42;
    case 'unrecognised':
      return 'paused_by_operator';
    default:
      return kind;
  }
}

let consoleLog: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
});

/** One report-mode run against a freshly seeded Firestore. */
async function runResume(seed: DocData | null): Promise<{
  log: OperationLog;
  db: ReturnType<typeof createFakeFirestore>;
  bucket: ReturnType<typeof createFakeBucket>;
  result: Awaited<ReturnType<typeof runStorageOrphanSweep>>;
}> {
  const log = createOperationLog();
  const db = createFakeFirestore({ log, collections: COLLECTIONS });
  if (seed) db.documents.set(tenantReportPath(TENANT), { ...seed });
  const bucket = createFakeBucket({ log, objects: fixtureObjects() });

  const result = await runStorageOrphanSweep({
    db: db as never,
    rtdb: createFakeRtdb({ log, tree: {} }) as never,
    bucket: bucket as never,
    // REPORT mode: the resume path, the cursor and the counters are what is under
    // test, and a mover would add quarantine accounting that has its own property.
    config: sweepConfig({ nowMs: NOW, pageSize: PAGE_SIZE, maxReferences: 10_000 }) as never,
    now: () => NOW,
  });

  return { log, db, bucket, result };
}

describe('Property 11: a Report_Document in the shipped shape always resumes', () => {
  /**
   * The current run's Reference_Fingerprint, learned from a discovery run rather than
   * recomputed in the test.
   *
   * A seeded document whose fingerprint differs from the current run's has its cursor
   * DISCARDED and its counters reset (Req 9.12) — correct behaviour, and it would make
   * every inheritance clause below fail for a reason that has nothing to do with the
   * recorded status. Reproducing the fingerprint here would mean reimplementing
   * "sha256 over the sorted retain set with NUL separators", which is the one thing a
   * test must not do; running the real collector once over the fixed fixture is both
   * honest and exact.
   */
  let fingerprint: string;

  beforeAll(async () => {
    const discovery = await runResume(null);
    expect(discovery.result.tenants[0].status).toBe('completed');
    const recorded = discovery.db.read(tenantReportPath(TENANT))!;
    expect(typeof recorded.referenceFingerprint).toBe('string');
    fingerprint = recorded.referenceFingerprint as string;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it(
    'inherits the cursor and the counters for every status but completed, and re-lists',
    async () => {
      /**
       * The arms, all of which must be reached. Two of them are the property's own
       * discriminations and would silently disappear if a generator drifted:
       * `absoluteIdentityViolated` proves the generated documents really do break the
       * accounting identity in absolute terms, so the delta-based check is doing work;
       * `continuedMidPrefix` proves at least one run resumed from a real page token
       * rather than from the top of a prefix.
       */
      const arms = {
        resumed: 0,
        earlyReturn: 0,
        absoluteIdentityViolated: 0,
        continuedMidPrefix: 0,
        outOfRangePrefixIndex: 0,
        unknownReasonKeys: 0,
      };

      await fc.assert(
        fc.asyncProperty(
          fc.record<LegacyDocInput>({
            status: fc.constantFrom(
              'in_progress',
              'failed',
              'completed',
              'absent',
              'non_string',
              'unrecognised'
            ),
            // Which of this spec's new fields are PRESENT; the rest are absent, which
            // is the shipped shape (Req 9.2).
            presentRootFields: fc.subarray([...NEW_ROOT_FIELDS]),
            presentParamFields: fc.subarray([...NEW_PARAM_FIELDS]),
            // `retainedByReason` keys the current code does not define (Req 9.5).
            unknownReasons: fc.subarray([
              'retained_by_a_future_reason',
              'legacy_reason',
              'referenced_v2',
            ]),
            // Sometimes past the last Managed_Category, which the resume clamps.
            prefixIndex: fc.integer({ min: 0, max: STORAGE_TENANT_CATEGORIES.length + 2 }),
            tokenKind: fc.constantFrom('none', 'well_formed', 'garbage'),
            // Non-negative, and deliberately unrelated to each other so the ABSOLUTE
            // accounting identity is violated. `objectsScanned` is at least 1 so
            // "inherited" is a discrimination rather than a comparison against zero.
            objectsScanned: fc.integer({ min: 1, max: 500 }),
            orphanCount: fc.integer({ min: 0, max: 500 }),
            // These two are generated WITHIN the orphan count, and the reason is a real
            // asymmetry worth recording: `assertSweepInvariants`'s FIRST check —
            // `quarantined + failures <= candidates` — is deliberately ABSOLUTE, while
            // the accounting identity below it is a DELTA check (Req 9.4). That is not
            // an inconsistency: the mutation ledger relates three counters the writer
            // always writes together and never re-derives, so any document any version
            // of this code wrote satisfies it, whereas the accounting identity relates
            // a scanned count to a breakdown whose REASON SET can change between
            // versions — which is the version skew Req 9.4 exists for.
            quarantinedCount: fc.integer({ min: 0, max: 250 }),
            quarantineFailures: fc.integer({ min: 0, max: 250 }),
            retained: fc.array(fc.integer({ min: 0, max: 400 }), {
              minLength: RETAIN_REASONS.length,
              maxLength: RETAIN_REASONS.length,
            }),
          }),
          async (input) => {
            const clampedIndex = Math.min(input.prefixIndex, STORAGE_TENANT_CATEGORIES.length);
            const inRange = clampedIndex < PREFIXES.length;
            const targetPrefix = inRange ? PREFIXES[clampedIndex] : null;
            const cursorName =
              targetPrefix === null ? null : `${targetPrefix}obj_0.bin`;
            const pageToken =
              input.tokenKind === 'none'
                ? null
                : input.tokenKind === 'garbage'
                  ? 'a-token-no-page-ever-produced'
                  : cursorName === null
                    ? null
                    : `after:${cursorName}`;

            const retainedByReason: Record<string, unknown> = {};
            RETAIN_REASONS.forEach((reason, index) => {
              retainedByReason[reason] = input.retained[index];
            });
            for (const unknown of input.unknownReasons) retainedByReason[unknown] = 7;

            const orphanCount = Math.max(
              input.orphanCount,
              input.quarantinedCount + input.quarantineFailures
            );

            // ── The document, in the SHIPPED field shape ──────────────────────
            const params: Record<string, unknown> = {
              graceDays: 7,
              graceCutoffMs: NOW - 7 * DAY,
              quarantineRetentionDays: 7,
              pageSize: PAGE_SIZE,
              maxQuarantinePerTenant: 1_000,
              maxReferences: 10_000,
              nowMs: NOW,
              force: false,
            };
            for (const field of input.presentParamFields) params[field] = 1;

            const seed: DocData = {
              tenantId: TENANT,
              mode: 'report',
              applied: false,
              sweepId: 'sweep_legacy_0001',
              runnerId: 'legacy-runner',
              referenceFingerprint: fingerprint,
              params,
              countsBySource: { notices: 1 },
              referenceCount: 1,
              derivedReferenceCount: 0,
              resume: { prefixIndex: input.prefixIndex, pageToken },
              objectsScanned: input.objectsScanned,
              retainedByReason,
              orphanCount,
              orphanBytes: 4_096,
              quarantinedCount: input.quarantinedCount,
              quarantinedBytes: 0,
              quarantineFailures: input.quarantineFailures,
              fieldReferencesObserved: 1,
              sampleOrphanPaths: [`notices/${TENANT}/obj_0.bin`],
              crossTenantReferences: [],
              crossTenantReferenceCount: 0,
              transcodeOnlyReferences: [],
              transcodeOnlyReferenceCount: 0,
              malformedReferences: 0,
              failedSources: [],
              partial: false,
              abortReason: null,
              danglingReferenceCount: 0,
              usageBytesBefore: null,
              usageBytesAfter: null,
              startedAt: new Date(NOW - DAY),
              updatedAt: new Date(NOW - DAY),
              completedAt: null,
              lastError: null,
            };
            const statusValue = recordedStatusValue(input.status);
            if (statusValue !== undefined) seed.status = statusValue;
            for (const field of input.presentRootFields) seed[field] = newRootValue(field);

            const inherited = inheritedFrom(seed);
            if (input.unknownReasons.length > 0) arms.unknownReasonKeys += 1;
            if (!inRange) arms.outOfRangePrefixIndex += 1;

            const absoluteRetained = RETAIN_REASONS.reduce(
              (sum, reason) => sum + inherited.retainedByReason[reason],
              0
            );
            if (inherited.objectsScanned !== absoluteRetained + inherited.orphanCount) {
              arms.absoluteIdentityViolated += 1;
            }

            // Req 9.1, 9.13 — asserted by EXECUTING the resume. A throw fails here;
            // nothing catches.
            const run = await runResume(seed);
            const tenant = run.result.tenants[0];
            expect(tenant).toBeDefined();
            expect(run.result.tenantFailures).toBe(0);

            const pagedCalls = run.bucket.getFilesCalls.filter(
              (call) => call.maxResults !== undefined
            );

            // Req 9.5 — an unknown recorded reason key is never READ: the resumed
            // breakdown carries exactly the reason set this version defines.
            expect(Object.keys(tenant.retainedByReason).sort()).toEqual([...RETAIN_REASONS].sort());

            if (input.status === 'completed') {
              // ── Req 9.9, 1.14: the ONE status that does not resume ───────────
              arms.earlyReturn += 1;
              expect(tenant.status).toBe('completed');
              // Nothing re-listed, and nothing re-written: an exact no-op.
              expect(pagedCalls).toEqual([]);
              expect(tenant.reportWrites).toBe(0);
              expect(
                run.log.filter(
                  (entry) =>
                    entry.method === 'doc.set' && entry.target === tenantReportPath(TENANT)
                )
              ).toEqual([]);
              // The RECORDED result is what comes back.
              expect(tenant.objectsScanned).toBe(inherited.objectsScanned);
              expect(tenant.orphanCount).toBe(inherited.orphanCount);
              expect(tenant.quarantinedCount).toBe(inherited.quarantinedCount);
              expect(tenant.retainedByReason).toEqual(inherited.retainedByReason);
              return;
            }

            // ── Every other recorded status takes the DEFAULT-TO-RESUME path ───
            arms.resumed += 1;

            // A write happened, which is what distinguishes the resume path from the
            // early return above whatever the cursor pointed at.
            expect((tenant.reportWrites ?? 0)).toBeGreaterThan(0);

            const examined = examinedNames(run.log);

            if (inRange) {
              // Req 1.13: the listing CONTINUED from the persisted cursor — the first
              // paged call is for the recorded prefix, carrying the recorded token.
              expect(pagedCalls.length).toBeGreaterThan(0);
              expect(pagedCalls[0].prefix).toBe(targetPrefix);
              expect(pagedCalls[0].pageToken).toBe(pageToken ?? undefined);
              if (input.tokenKind === 'well_formed') {
                arms.continuedMidPrefix += 1;
                // The object the cursor names was examined by the earlier attempt and
                // is not re-examined by this one.
                expect(examined).not.toContain(cursorName);
              }
            } else {
              // An out-of-range `prefixIndex` is clamped to the prefix count, so the
              // listing loop has nothing left to walk. Still the resume path — the
              // counters are inherited and the report is written — which is what makes
              // this case backward compatibility rather than a crash (Req 9.3).
              expect(pagedCalls).toEqual([]);
            }

            // Req 1.13, 9.13 — the counters are INHERITED, not restarted. A
            // restart-from-scratch branch would give `examined.length` alone.
            expect(tenant.objectsScanned).toBe(inherited.objectsScanned + examined.length);
            expect(tenant.quarantinedCount).toBe(inherited.quarantinedCount);
            expect(tenant.quarantineFailures).toBe(inherited.quarantineFailures);
            for (const reason of RETAIN_REASONS) {
              expect(tenant.retainedByReason[reason]).toBeGreaterThanOrEqual(
                inherited.retainedByReason[reason]
              );
            }

            // ── Req 9.4: the DELTA accounting identity, for the pages THIS process
            // examined. The absolute one is violated by construction on many of these
            // documents (see `absoluteIdentityViolated`), and a resume that asserted
            // absolute totals would therefore crash on them.
            const scannedDelta = tenant.objectsScanned - inherited.objectsScanned;
            const retainedDelta = RETAIN_REASONS.reduce(
              (sum, reason) =>
                sum + (tenant.retainedByReason[reason] - inherited.retainedByReason[reason]),
              0
            );
            const orphanDelta = tenant.orphanCount - inherited.orphanCount;
            expect(scannedDelta).toBe(examined.length);
            expect(scannedDelta).toBe(retainedDelta + orphanDelta);

            // Req 9.15 — the persisted document stays readable by a reader that does
            // not define `'failed'`: an UNRECOGNISED status, never an invalid
            // document, and every other field still parses.
            const persisted = run.db.read(tenantReportPath(TENANT))!;
            const predating = readAsPredatingReader(persisted);
            expect(predating.fieldCount).toBeGreaterThan(20);
            expect(predating.referenceFingerprint).toBe(fingerprint);
            expect(Number.isFinite(predating.objectsScanned)).toBe(true);
            if (predating.recognisedStatus === null) {
              expect(predating.unrecognisedStatus).toBe(persisted.status);
              // And such a reader still resumes, because "not completed" is what it
              // branches on — correct behaviour arrived at by not recognising the value.
              expect(predating.wouldResume).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );

      expect(arms.resumed).toBeGreaterThan(0);
      expect(arms.earlyReturn).toBeGreaterThan(0);
      expect(arms.absoluteIdentityViolated).toBeGreaterThan(0);
      expect(arms.continuedMidPrefix).toBeGreaterThan(0);
      expect(arms.outOfRangePrefixIndex).toBeGreaterThan(0);
      expect(arms.unknownReasonKeys).toBeGreaterThan(0);
    },
    240_000
  );

  /**
   * Req 9.15, stated over a document this job actually wrote rather than over a
   * hand-assembled one.
   *
   * A hand-built `{ status: 'failed' }` proves that a helper can read a literal. What
   * matters is that the document `sweepTenant`'s catch REALLY writes — status,
   * `lastError`, `runnerId` and `updatedAt` merged over a previous page's cursor and
   * counters — is readable by a reader whose union predates the value.
   */
  it('leaves a real failed Report_Document readable by a reader that predates the value', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: COLLECTIONS });
    const objects = fixtureObjects();
    let pagedSeen = 0;
    const bucket = createFakeBucket({
      log,
      objects,
      failGetFiles: (call) => {
        if (call.maxResults === undefined) return undefined;
        pagedSeen += 1;
        return pagedSeen === 2 ? new Error('listing page failed') : undefined;
      },
    });

    const run = await runStorageOrphanSweep({
      db: db as never,
      rtdb: createFakeRtdb({ log, tree: {} }) as never,
      bucket: bucket as never,
      config: sweepConfig({
        nowMs: NOW,
        pageSize: PAGE_SIZE,
        maxReferences: 10_000,
        // One write per page, so the failure lands on a document that already carries a
        // cursor and counters — which is the document Req 9.15 is about.
        reportWritePages: 1,
      }) as never,
      now: () => NOW,
    });

    expect(run.tenants[0].status).toBe('failed');
    const persisted = db.read(tenantReportPath(TENANT))!;
    expect(persisted.status).toBe('failed');

    const predating = readAsPredatingReader(persisted);
    // An unrecognised status — the document itself is not rejected.
    expect(predating.recognisedStatus).toBeNull();
    expect(predating.unrecognisedStatus).toBe('failed');
    // Every other field still parses, including the two the resume path needs.
    expect(predating.referenceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(predating.objectsScanned).toBeGreaterThan(0);
    expect(predating.resume).not.toBeNull();
    // And a predating reader resumes it, because only `'completed'` means "done".
    expect(predating.wouldResume).toBe(true);
    expect(typeof persisted.lastError).toBe('string');
  });
});
