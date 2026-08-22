// Feature: storage-orphan-cleanup, Property 13: Quota reconciliation converges and never under-counts
/**
 * Property 13: Quota reconciliation converges and never under-counts
 * **Validates: Requirements 14.3, 14.4, 14.6, 14.8, 14.9, 14.10**
 *
 * The convergence claim is scoped to **apply mode**, because apply mode is the
 * only mode that writes.
 *
 * *For any* generated bucket state, set of `videoTranscodes` exclusions and set of
 * quarantine moves, an **apply-mode** run writes a `tenantStorageUsage.bytes`
 * equal to `estimateTenantStorageBytes` over the POST-sweep bucket — the sum of
 * the six Managed_Category prefixes less the `originalDeleted` exclusion set — so
 * quarantined objects contribute **zero**, because `_orphan-quarantine/` is not
 * among the summed prefixes. Recorded usage after ≤ recorded usage before for any
 * `n ≥ 0` moves, and a failed quarantine delete leaves both copies and therefore
 * OVER-counts rather than under-counts.
 *
 * *For any* **report-mode** run the claim is the weaker, correct one: the recompute
 * happens **exactly once** and agrees with the unchanged bucket, while
 * `tenantStorageUsage` is not written and the live-count cache is not invalidated.
 * Report mode asserts *agreement*, not convergence —
 * `tenantStorageUsage.bytes` cannot converge in a mode that never writes it, and
 * pretending otherwise would put an exception into Property 6.
 *
 * The summing model below is written out independently, mirroring the model already
 * present in `estimateTenantStorageBytes.property.test.ts`, so the assertion is
 * against a statement of the rule rather than against a second call to the code
 * under test.
 */

import * as fc from 'fast-check';

import { STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';
import { runStorageOrphanSweep, tenantReportPath } from '../jobs/storageOrphanSweep';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  createTestQuarantineMover,
  iso,
  sweepConfig,
  type FakeBucket,
  type FakeObject,
  type GetFilesCall,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
const OLD = iso(NOW - 400 * DAY);

/**
 * The rule, stated independently: sum `metadata.size` over the six
 * Managed_Category prefixes of this tenant, skipping the originals of
 * `videoTranscodes` documents that record `originalDeleted: true`.
 *
 * `_orphan-quarantine/` is not a Managed_Category, so a quarantined object
 * contributes zero without any special case — which is the whole reason the
 * quarantine namespace sits outside the tuple.
 */
function modelStorageBytes(bucket: FakeBucket, excludePaths: Set<string>): number {
  const prefixes = STORAGE_TENANT_CATEGORIES.map((category) => `${category}/${TENANT}/`);
  let total = 0;
  for (const object of bucket.contents().values()) {
    if (excludePaths.has(object.name)) continue;
    if (!prefixes.some((prefix) => object.name.startsWith(prefix))) continue;
    if (Number.isFinite(object.size) && object.size > 0) total += object.size;
  }
  return total;
}

/** The recompute's listing calls: unpaged, one per Managed_Category prefix. */
function recomputeCalls(calls: GetFilesCall[]): GetFilesCall[] {
  return calls.filter((call) => call.maxResults === undefined);
}

interface GeneratedObject {
  category: string;
  size: number;
  referenced: boolean;
  /** A transcode original whose document records `originalDeleted: true`. */
  excluded: boolean;
}

const generatedObjectArb: fc.Arbitrary<GeneratedObject> = fc.record({
  category: fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
  size: fc.integer({ min: 0, max: 250_000 }),
  referenced: fc.boolean(),
  excluded: fc.boolean(),
});

interface Fixture {
  objects: FakeObject[];
  collections: Record<string, Record<string, Record<string, unknown>>>;
  excludePaths: Set<string>;
}

function buildFixture(generated: GeneratedObject[]): Fixture {
  const objects: FakeObject[] = [];
  const notices: Record<string, Record<string, unknown>> = {};
  const videoTranscodes: Record<string, Record<string, unknown>> = {};
  const excludePaths = new Set<string>();

  generated.forEach((entry, index) => {
    // Only chat videos can plausibly be a transcode original, so the exclusion
    // cases are put where they really occur.
    const isTranscodeOriginal = entry.excluded && entry.category === 'chat-files';
    const objectPath = isTranscodeOriginal
      ? `chat-files/${TENANT}/c_1/k_${index}_clip.mov`
      : `${entry.category}/${TENANT}/obj_${String(index).padStart(3, '0')}.bin`;

    objects.push({ name: objectPath, size: entry.size, timeCreated: OLD, updated: OLD });

    if (isTranscodeOriginal) {
      excludePaths.add(objectPath);
      videoTranscodes[`doc_${index}`] = {
        tenantId: TENANT,
        status: 'done',
        originalPath: objectPath,
        originalDeleted: true,
      };
    }
    if (entry.referenced) {
      notices[`notice_${index}`] = { tenantId: TENANT, imageStoragePath: objectPath };
    }
  });

  return { objects, collections: { notices, videoTranscodes }, excludePaths };
}

let consoleLog: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
});

describe('Property 13: quota reconciliation converges and never under-counts', () => {
  it('report mode: recomputes exactly once, agrees with the unchanged bucket, writes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(generatedObjectArb, { minLength: 0, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom({ mode: 'report' as const, apply: false }, { mode: 'sweep' as const, apply: false }),
        async (generated, pageSize, mode) => {
          const fixture = buildFixture(generated);
          const log = createOperationLog();
          const bucket = createFakeBucket({ log, objects: fixture.objects });
          const db = createFakeFirestore({
            log,
            collections: {
              ...fixture.collections,
              tenantStorageUsage: { [TENANT]: { tenantId: TENANT, bytes: 123_456 } },
            },
          });
          const invalidated: string[] = [];

          const run = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log, tree: {} }) as never,
            bucket: bucket as never,
            config: sweepConfig({ ...mode, pageSize, nowMs: NOW }) as never,
            invalidateLiveCount: (key) => void invalidated.push(key),
          });

          const result = run.tenants[0];
          const expected = modelStorageBytes(bucket, fixture.excludePaths);

          // Exactly ONE recompute per tenant per run: six unpaged prefix listings,
          // no more (Req 14.1).
          const recompute = recomputeCalls(bucket.getFilesCalls);
          expect(recompute.length).toBe(STORAGE_TENANT_CATEGORIES.length);
          expect([...recompute.map((call) => call.prefix)].sort()).toEqual(
            STORAGE_TENANT_CATEGORIES.map((category) => `${category}/${TENANT}/`).sort()
          );

          // It agrees with the unchanged bucket, and is recorded on the report.
          expect(result.usageBytesAfter).toBe(expected);
          expect(result.usageBytesBefore).toBe(123_456);
          expect(db.read(tenantReportPath(TENANT))!.usageBytesAfter).toBe(expected);

          // And the Storage_Usage_Record is untouched, the cache un-invalidated
          // (Req 14.4). This is the clause that keeps Property 6 exception-free.
          expect(db.read(`tenantStorageUsage/${TENANT}`)).toEqual({
            tenantId: TENANT,
            bytes: 123_456,
          });
          expect(invalidated).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('apply mode: the written value equals the model over the post-sweep bucket', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(generatedObjectArb, { minLength: 0, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        async (generated, pageSize) => {
          const fixture = buildFixture(generated);
          const log = createOperationLog();
          const bucket = createFakeBucket({ log, objects: fixture.objects });
          const before = modelStorageBytes(bucket, fixture.excludePaths);
          const db = createFakeFirestore({
            log,
            collections: {
              ...fixture.collections,
              tenantStorageUsage: { [TENANT]: { tenantId: TENANT, bytes: before } },
            },
          });
          const invalidated: string[] = [];

          const run = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log, tree: {} }) as never,
            bucket: bucket as never,
            config: sweepConfig({
              mode: 'sweep',
              apply: true,
              pageSize,
              nowMs: NOW,
              sweepId: 'sweep_quota',
            }) as never,
            quarantineObject: createTestQuarantineMover(log),
            invalidateLiveCount: (key) => void invalidated.push(key),
          });

          const result = run.tenants[0];
          const expected = modelStorageBytes(bucket, fixture.excludePaths);

          // Convergence: the written value IS the recompute over bucket truth.
          const record = db.read(`tenantStorageUsage/${TENANT}`)!;
          expect(record.bytes).toBe(expected);
          expect(result.usageBytesAfter).toBe(expected);
          expect(invalidated).toEqual([`storageBytes:${TENANT}`]);
          expect(recomputeCalls(bucket.getFilesCalls).length).toBe(
            STORAGE_TENANT_CATEGORIES.length
          );

          // Quarantined objects contribute ZERO: the bytes are still in the bucket,
          // under a prefix the sum does not visit.
          const quarantined = Array.from(bucket.contents().values()).filter((object) =>
            object.name.startsWith('_orphan-quarantine/')
          );
          expect(quarantined.length).toBe(result.quarantinedCount);
          for (const object of quarantined) {
            expect(object.name.startsWith(`_orphan-quarantine/${TENANT}/sweep_quota/`)).toBe(true);
          }

          // For n ≥ 0 moves, recorded usage after ≤ recorded usage before.
          expect(record.bytes as number).toBeLessThanOrEqual(before);
          if (result.quarantinedCount === 0) {
            expect(record.bytes).toBe(before);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('apply mode: a failed quarantine delete over-counts rather than under-counting', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            size: fc.integer({ min: 1, max: 100_000 }),
            deleteFails: fc.boolean(),
          }),
          { minLength: 1, maxLength: 8 }
        ),
        async (entries) => {
          const objects: FakeObject[] = entries.map((entry, index) => ({
            name: `receipts/${TENANT}/fee_${index}/k_${index}_receipt.pdf`,
            size: entry.size,
            timeCreated: OLD,
            updated: OLD,
          }));
          const failing = new Set(
            entries
              .map((entry, index) =>
                entry.deleteFails ? `receipts/${TENANT}/fee_${index}/k_${index}_receipt.pdf` : null
              )
              .filter((value): value is string => value !== null)
          );

          const log = createOperationLog();
          const bucket = createFakeBucket({
            log,
            objects,
            failDelete: (objectPath) =>
              failing.has(objectPath) ? new Error('delete failed: 503') : undefined,
          });
          const db = createFakeFirestore({ log, collections: {} });

          const run = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log, tree: {} }) as never,
            bucket: bucket as never,
            config: sweepConfig({
              mode: 'sweep',
              apply: true,
              nowMs: NOW,
              sweepId: 'sweep_quota_fail',
            }) as never,
            quarantineObject: createTestQuarantineMover(log),
          });

          const result = run.tenants[0];
          const written = db.read(`tenantStorageUsage/${TENANT}`)!.bytes as number;
          const actual = modelStorageBytes(bucket, new Set());
          // The recompute always states bucket truth …
          expect(written).toBe(actual);
          expect(result.quarantineFailures).toBe(failing.size);

          // … and where a delete failed, both copies exist, so the original is
          // still summed: the record OVER-counts relative to the bytes the tenant
          // is really relying on, and never under-counts (Req 14.10).
          const overCounted = objects
            .filter((object) => failing.has(object.name))
            .reduce((total, object) => total + object.size, 0);
          expect(written).toBe(overCounted);
          for (const objectPath of failing) {
            expect(bucket.contents().has(objectPath)).toBe(true);
            expect(
              bucket
                .contents()
                .has(`_orphan-quarantine/${TENANT}/sweep_quota_fail/${objectPath}`)
            ).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
