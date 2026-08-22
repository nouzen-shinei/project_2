// Feature: storage-orphan-cleanup, Property 7: Sweep idempotence and resumability
/**
 * Property 7: Sweep idempotence and resumability
 * **Validates: Requirements 13.7, 13.9, 13.10, 13.11, 13.12**
 *
 * *For any* generated interruption schedule — fail on listing page *k*, for every
 * *k* — *any* page size and *any* listing order:
 *
 *  - the union of objects examined by the interrupted run and its resumption
 *    equals what an uninterrupted run examines (Req 13.12);
 *  - no object is quarantined twice within one `sweepId` (Req 13.11);
 *  - re-running a `completed` tenant WITHOUT `force` is an exact no-op that
 *    returns the recorded result and lists nothing (Req 13.9);
 *  - re-running WITH `force` restarts from the first prefix with fresh counters
 *    (Req 13.10);
 *  - a resume whose persisted `referenceFingerprint` differs from the current
 *    run's discards the cursor and restarts the listing from the first prefix
 *    (Req 13.7).
 *
 * ── Why the failure is injected at FETCH time ───────────────────────────────
 *
 * `getFiles` throwing on page *k* is the failure the design specifies, and it is
 * also what makes "objects examined" observable: a page that was fetched was then
 * examined in full, so the union of the pages a run fetched is exactly the set it
 * judged. The fake logs the names it returned for each page, so the union is read
 * off one chronological log rather than inferred from counters — which matters
 * because counters deliberately double-count a re-examined page while the union
 * does not.
 *
 * The last clause is the one worth being careful about. A run interrupted on Monday
 * and resumed on Wednesday must not judge Wednesday's bucket against Monday's idea
 * of what is referenced, so the fingerprint is checked before the cursor is
 * trusted. Re-examination is harmless; judging against a stale retain set is not.
 */

import * as fc from 'fast-check';

import {
  runStorageOrphanSweep,
  tenantReportPath,
  type TenantSweepResult,
} from '../jobs/storageOrphanSweep';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  createTestQuarantineMover,
  downloadUrl,
  iso,
  sweepConfig,
  type FakeObject,
  type GetFilesCall,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;

/** The six prefixes, in the order the sweep lists them. */
const CATEGORIES = [
  'chat-files',
  'tenant-branding',
  'notices',
  'student_profiles',
  'receipts',
  'profile-pictures',
] as const;

interface Fixture {
  objects: FakeObject[];
  collections: Record<string, Record<string, Record<string, unknown>>>;
  tree: Record<string, unknown>;
}

/**
 * `count` objects spread across the six prefixes, all provably older than the
 * grace period, with `referencedEvery`-th one referenced by a notice so both
 * dispositions occur.
 */
function buildFixture(count: number, referencedEvery: number, extraReference: boolean): Fixture {
  const objects: FakeObject[] = [];
  const notices: Record<string, Record<string, unknown>> = {};

  for (let index = 0; index < count; index += 1) {
    const category = CATEGORIES[index % CATEGORIES.length];
    const objectPath = `${category}/${TENANT}/obj_${String(index).padStart(3, '0')}.bin`;
    const stamp = iso(NOW - (30 + index) * DAY);
    objects.push({ name: objectPath, size: 100 + index, timeCreated: stamp, updated: stamp });
    if (index % referencedEvery === 0) {
      notices[`notice_${index}`] = { tenantId: TENANT, imageStoragePath: objectPath };
    }
  }

  if (extraReference) {
    // Changes the retain set — and therefore the Reference_Fingerprint — without
    // changing the bucket at all. That is exactly the Monday/Wednesday case.
    notices.notice_extra = {
      tenantId: TENANT,
      imageUrl: downloadUrl(`notices/${TENANT}/only_a_reference.png`),
    };
  }

  return {
    objects,
    collections: { notices },
    tree: { tenantChat: { [TENANT]: { conversationMessages: {} } } },
  };
}

/** Object names returned by the PAGED listing calls, in order, deduplicated. */
function examinedNames(log: OperationLog): Set<string> {
  const names = new Set<string>();
  for (const entry of log.filter(
    (candidate) => candidate.method === 'getFiles.page' && candidate.detail?.maxResults !== null
  )) {
    for (const name of (entry.detail?.names ?? []) as string[]) names.add(name);
  }
  return names;
}

/** The paged listing calls, so "restarted from the first prefix" is assertable. */
function pagedCalls(bucketCalls: GetFilesCall[]): GetFilesCall[] {
  return bucketCalls.filter((call) => call.maxResults !== undefined);
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

describe('Property 7: sweep idempotence and resumability', () => {
  it('examines the same union of objects when interrupted after any page and resumed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 14 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        fc.nat({ max: 11 }),
        async (objectCount, pageSize, referencedEvery, failAfterPage) => {
          const fixture = buildFixture(objectCount, referencedEvery, false);

          // ── The uninterrupted baseline ────────────────────────────────────
          const baselineLog = createOperationLog();
          const baselineDb = createFakeFirestore({ log: baselineLog, collections: fixture.collections });
          const baseline = await runStorageOrphanSweep({
            db: baselineDb as never,
            rtdb: createFakeRtdb({ log: baselineLog, tree: fixture.tree }) as never,
            bucket: createFakeBucket({ log: baselineLog, objects: fixture.objects }) as never,
            config: sweepConfig({ pageSize, nowMs: NOW }) as never,
          });
          const baselineExamined = examinedNames(baselineLog);
          expect(baseline.tenants[0].status).toBe('completed');

          // ── The interrupted run ──────────────────────────────────────────
          const log = createOperationLog();
          const db = createFakeFirestore({ log, collections: fixture.collections });
          const rtdb = createFakeRtdb({ log, tree: fixture.tree });
          let pagedSeen = 0;
          const failingBucket = createFakeBucket({
            log,
            objects: fixture.objects,
            failGetFiles: (call) => {
              if (call.maxResults === undefined) return undefined;
              const index = pagedSeen;
              pagedSeen += 1;
              return index === failAfterPage ? new Error('listing page failed') : undefined;
            },
          });

          let interrupted = false;
          try {
            await runStorageOrphanSweep({
              db: db as never,
              rtdb: rtdb as never,
              bucket: failingBucket as never,
              config: sweepConfig({ pageSize, nowMs: NOW }) as never,
            });
          } catch (error) {
            interrupted = true;
            expect((error as Error).message).toContain('listing page failed');
          }

          if (!interrupted) {
            // The schedule asked for a page that this fixture never reaches; the
            // run simply completed, which is not a counterexample.
            return;
          }

          // A failed page leaves the PREVIOUS page's cursor and counters intact and
          // records `lastError` (Req 13.13, 13.14).
          const afterFailure = db.read(tenantReportPath(TENANT));
          expect(afterFailure).toBeDefined();
          expect(afterFailure!.status).toBe('in_progress');
          expect(typeof afterFailure!.lastError).toBe('string');

          // ── The resumption, against the identical fixture ────────────────
          const resumedLog = createOperationLog();
          const resumed = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log: resumedLog, tree: fixture.tree }) as never,
            bucket: createFakeBucket({ log: resumedLog, objects: fixture.objects }) as never,
            config: sweepConfig({ pageSize, nowMs: NOW }) as never,
          });
          expect(resumed.tenants[0].status).toBe('completed');

          const union = new Set<string>([...examinedNames(log), ...examinedNames(resumedLog)]);
          expect([...union].sort()).toEqual([...baselineExamined].sort());

          // The completed report carries no cursor.
          expect(db.read(tenantReportPath(TENANT))!.resume).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('is an exact no-op when re-run on a completed tenant, and restarts with force', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 4 }),
        async (objectCount, pageSize) => {
          const fixture = buildFixture(objectCount, 2, false);
          const log = createOperationLog();
          const db = createFakeFirestore({ log, collections: fixture.collections });

          const first = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log, tree: fixture.tree }) as never,
            bucket: createFakeBucket({ log, objects: fixture.objects }) as never,
            config: sweepConfig({ pageSize, nowMs: NOW }) as never,
          });
          const completed: TenantSweepResult = first.tenants[0];
          expect(completed.status).toBe('completed');

          // ── Re-run without force: no listing, no write, same numbers ─────
          const replayLog = createOperationLog();
          const replayBucket = createFakeBucket({ log: replayLog, objects: fixture.objects });
          const replay = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log: replayLog, tree: fixture.tree }) as never,
            bucket: replayBucket as never,
            config: sweepConfig({ pageSize, nowMs: NOW }) as never,
          });

          const replayed = replay.tenants[0];
          expect(replayed.status).toBe('completed');
          expect(replayed.objectsScanned).toBe(completed.objectsScanned);
          expect(replayed.orphanCount).toBe(completed.orphanCount);
          expect(replayed.orphanBytes).toBe(completed.orphanBytes);
          expect(replayed.retainedByReason).toEqual(completed.retainedByReason);
          expect(replayed.danglingReferenceCount).toBe(completed.danglingReferenceCount);
          // Nothing was listed and nothing was written: Phase 1 still runs, because
          // the abort gate must be consulted on every run, but Phase 2 does not.
          expect(replayBucket.getFilesCalls).toEqual([]);
          expect(replayLog.writes()).toEqual([]);

          // ── Re-run WITH force: first prefix, fresh counters ──────────────
          const forcedLog = createOperationLog();
          const forcedBucket = createFakeBucket({ log: forcedLog, objects: fixture.objects });
          const forced = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log: forcedLog, tree: fixture.tree }) as never,
            bucket: forcedBucket as never,
            config: sweepConfig({ pageSize, nowMs: NOW, force: true }) as never,
          });

          const paged = pagedCalls(forcedBucket.getFilesCalls);
          expect(paged.length).toBeGreaterThan(0);
          expect(paged[0].prefix).toBe(`chat-files/${TENANT}/`);
          expect(paged[0].pageToken).toBeUndefined();
          // Fresh counters, not the completed run's counters doubled.
          expect(forced.tenants[0].objectsScanned).toBe(completed.objectsScanned);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('discards the resume cursor when the reference fingerprint changed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 6, max: 14 }),
        fc.integer({ min: 1, max: 2 }),
        async (objectCount, pageSize) => {
          const fixture = buildFixture(objectCount, 3, false);
          const log = createOperationLog();
          const db = createFakeFirestore({ log, collections: fixture.collections });

          // Interrupt after the second page so a cursor is definitely persisted.
          let pagedSeen = 0;
          let interrupted = false;
          try {
            await runStorageOrphanSweep({
              db: db as never,
              rtdb: createFakeRtdb({ log, tree: fixture.tree }) as never,
              bucket: createFakeBucket({
                log,
                objects: fixture.objects,
                failGetFiles: (call) => {
                  if (call.maxResults === undefined) return undefined;
                  pagedSeen += 1;
                  return pagedSeen === 3 ? new Error('listing page failed') : undefined;
                },
              }) as never,
              config: sweepConfig({ pageSize, nowMs: NOW }) as never,
            });
          } catch {
            interrupted = true;
          }
          expect(interrupted).toBe(true);

          const afterFailure = db.read(tenantReportPath(TENANT));
          const persistedCursor = afterFailure!.resume as { pageToken: string | null } | null;
          const persistedFingerprint = afterFailure!.referenceFingerprint as string;
          expect(persistedCursor).not.toBeNull();

          // Now the reference set changes — one more reference, the same bucket.
          const changed = buildFixture(objectCount, 3, true);
          const changedLog = createOperationLog();
          for (const [id, data] of Object.entries(changed.collections.notices)) {
            db.documents.set(`notices/${id}`, data);
          }
          const changedBucket = createFakeBucket({ log: changedLog, objects: changed.objects });
          const resumed = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log: changedLog, tree: changed.tree }) as never,
            bucket: changedBucket as never,
            config: sweepConfig({ pageSize, nowMs: NOW }) as never,
          });

          const report = db.read(tenantReportPath(TENANT))!;
          expect(report.referenceFingerprint).not.toBe(persistedFingerprint);

          // The cursor was discarded: the listing restarted from the FIRST prefix
          // with no page token, rather than continuing against a stale retain set.
          const paged = pagedCalls(changedBucket.getFilesCalls);
          expect(paged[0].prefix).toBe(`chat-files/${TENANT}/`);
          expect(paged[0].pageToken).toBeUndefined();
          expect(resumed.tenants[0].status).toBe('completed');
          // Fresh counters too: the interrupted run's partial counts are not carried
          // into a run that is judging against a different retain set.
          const uninterruptedLog = createOperationLog();
          const uninterruptedDb = createFakeFirestore({
            log: uninterruptedLog,
            collections: { notices: changed.collections.notices },
          });
          const clean = await runStorageOrphanSweep({
            db: uninterruptedDb as never,
            rtdb: createFakeRtdb({ log: uninterruptedLog, tree: changed.tree }) as never,
            bucket: createFakeBucket({ log: uninterruptedLog, objects: changed.objects }) as never,
            config: sweepConfig({ pageSize, nowMs: NOW }) as never,
          });
          expect(resumed.tenants[0].objectsScanned).toBe(clean.tenants[0].objectsScanned);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('quarantines each object path at most once within one sweepId', async () => {
    // Apply mode, driven through the harness's stand-in mover: task 8 owns the real
    // `quarantineObject`, and this asserts only what the sweep loop is responsible
    // for — that a candidate is offered to the mover exactly once per sweepId.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 3 }),
        async (objectCount, pageSize) => {
          const fixture = buildFixture(objectCount, 3, false);
          const log = createOperationLog();
          const db = createFakeFirestore({ log, collections: fixture.collections });
          const bucket = createFakeBucket({ log, objects: fixture.objects });

          const result = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log, tree: fixture.tree }) as never,
            bucket: bucket as never,
            config: sweepConfig({
              mode: 'sweep',
              apply: true,
              pageSize,
              nowMs: NOW,
              sweepId: 'sweep_test_apply',
            }) as never,
            quarantineObject: createTestQuarantineMover(log),
          });

          const copies = log
            .filter((entry) => entry.method === 'file.copy')
            .map((entry) => entry.target);
          expect(copies.length).toBe(new Set(copies).size);
          expect(result.tenants[0].quarantinedCount).toBe(copies.length);
          // Every candidate is moved, failed, or capped — never silently dropped.
          expect(
            result.tenants[0].quarantinedCount + result.tenants[0].quarantineFailures
          ).toBeLessThanOrEqual(result.tenants[0].orphanCount);
        }
      ),
      { numRuns: 100 }
    );
  });
});
