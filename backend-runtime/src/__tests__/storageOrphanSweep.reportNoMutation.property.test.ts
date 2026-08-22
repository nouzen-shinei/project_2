// Feature: storage-orphan-cleanup, Property 6: Report mode performs no mutation of any kind
/**
 * Property 6: Report mode performs no mutation of any kind
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 14.4, 6.13**
 *
 * *For any* tenant, *any* reference-source content and *any* generated bucket
 * listing — including listings where every object is unreferenced — a run with
 * `mode: 'report'`, and equally `mode: 'sweep'` with `apply: false`, invokes
 * **no** mutating bucket method (`save`, `copy`, `delete`, `move`, `setMetadata`,
 * `makePublic`, `createWriteStream`), **no** Realtime Database
 * `set`/`update`/`remove`/`push`/`transaction`, and **no** Firestore write
 * outside `storageMaintenanceJobs/`.
 *
 * ── Why this is asserted over the METHODS INVOKED ───────────────────────────
 *
 * The recording fakes log every method name they are asked for, so the assertion
 * is over the *set of calls attempted* rather than over an outcome. A mutation
 * that happened to be a no-op — a `delete` of an object that was already gone, a
 * `set` writing the value that was already there — still fails this property.
 * That matters because this is the gate that lets task 8 exist at all: the code
 * that can move an object lands only after the report has been proven incapable
 * of moving one.
 *
 * ── The one subtlety: the quota recompute ───────────────────────────────────
 *
 * Report mode still PERFORMS the single `estimateTenantStorageBytes` recompute and
 * records the result as `usageBytesAfter`. That is a `getFiles` plus a sum, i.e. a
 * read; computing a number is not writing it. What report mode does not do is
 * write `tenantStorageUsage`, which is an application collection outside
 * `storageMaintenanceJobs/` — asserted specifically below, in both directions:
 * the document is NOT written AND the number IS recorded.
 */

import * as fc from 'fast-check';

import { STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';
import { runStorageOrphanSweep, tenantReportPath } from '../jobs/storageOrphanSweep';
import {
  BUCKET_NAME,
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  downloadUrl,
  iso,
  sweepConfig,
  type FakeObject,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;

/** Every bucket mutator Req 10.2 names, plus the two ways to obtain a writer. */
const FORBIDDEN_BUCKET_METHODS = [
  'bucket.file.save',
  'bucket.file.copy',
  'bucket.file.delete',
  'bucket.file.move',
  'bucket.file.setMetadata',
  'bucket.file.makePublic',
  'bucket.file.createWriteStream',
];

/** Every Realtime Database mutator Req 10.3 names. */
const FORBIDDEN_RTDB_METHODS = [
  'rtdb.set',
  'rtdb.update',
  'rtdb.remove',
  'rtdb.push',
  'rtdb.transaction',
];

// ─── Generators ──────────────────────────────────────────────────────────────

type MetadataShape = 'both' | 'createdOnly' | 'updatedOnly' | 'none';

interface GeneratedObject {
  category: string;
  slug: string;
  ageDays: number;
  size: number;
  referenced: boolean;
  metadataShape: MetadataShape;
  /** Which Reference_Source proves it, when it is referenced at all. */
  via: 'notice_path' | 'fee_receipt' | 'chat_message';
}

/** A short hex slug. `fc.hexaString` was removed in fast-check v4. */
const hexSlugArb = fc.integer({ min: 0x1000, max: 0xffffff }).map((value) => value.toString(16));

const generatedObjectArb: fc.Arbitrary<GeneratedObject> = fc.record({
  category: fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
  slug: hexSlugArb,
  ageDays: fc.integer({ min: 0, max: 400 }),
  size: fc.integer({ min: 0, max: 5_000_000 }),
  referenced: fc.boolean(),
  metadataShape: fc.constantFrom<MetadataShape>('both', 'createdOnly', 'updatedOnly', 'none'),
  via: fc.constantFrom<GeneratedObject['via']>('notice_path', 'fee_receipt', 'chat_message'),
});

/**
 * The three non-mutating mode combinations. `mode: 'report'` with `apply: true` is
 * included deliberately: only `sweep` AND `apply` may mutate (Req 10.1), so a
 * single mistyped switch must still be inert.
 */
const reportModeArb = fc.constantFrom(
  { mode: 'report' as const, apply: false },
  { mode: 'report' as const, apply: true },
  { mode: 'sweep' as const, apply: false }
);

interface Fixture {
  objects: FakeObject[];
  collections: Record<string, Record<string, Record<string, unknown>>>;
  tree: Record<string, unknown>;
  inScopeCandidates: number;
}

function buildFixture(generated: GeneratedObject[]): Fixture {
  const objects = new Map<string, FakeObject>();
  const notices: Record<string, Record<string, unknown>> = {};
  const fees: Record<string, Record<string, unknown>> = {};
  const messages: Record<string, Record<string, unknown>> = {};

  generated.forEach((entry, index) => {
    const extension = entry.category === 'profile-pictures' ? 'jpg' : 'bin';
    const objectPath = `${entry.category}/${TENANT}/${entry.slug}_${index}.${extension}`;
    if (objects.has(objectPath)) return;

    const touched = NOW - entry.ageDays * DAY;
    const stamp = iso(touched);
    objects.set(objectPath, {
      name: objectPath,
      size: entry.size,
      ...(entry.metadataShape === 'both' ? { timeCreated: stamp, updated: stamp } : {}),
      ...(entry.metadataShape === 'createdOnly' ? { timeCreated: stamp } : {}),
      ...(entry.metadataShape === 'updatedOnly' ? { updated: stamp } : {}),
    });

    if (!entry.referenced) return;
    if (entry.via === 'notice_path') {
      notices[`notice_${index}`] = { tenantId: TENANT, imageStoragePath: objectPath };
    } else if (entry.via === 'fee_receipt') {
      fees[`fee_${index}`] = { tenantId: TENANT, receipts: [{ url: downloadUrl(objectPath) }] };
    } else {
      messages[`-msg_${String(index).padStart(4, '0')}`] = {
        sender: 'teacher@example.com',
        recipientId: 'student@example.com',
        fileUrl: downloadUrl(objectPath),
      };
    }
  });

  return {
    objects: Array.from(objects.values()),
    collections: { notices, fees },
    tree: {
      tenantChat: { [TENANT]: { conversationMessages: { c_1: messages } } },
    },
    inScopeCandidates: 0,
  };
}

// ─── The property ────────────────────────────────────────────────────────────

let consoleLog: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
});

describe('Property 6: report mode performs no mutation of any kind', () => {
  it('invokes no bucket mutator, no RTDB write and no Firestore write outside storageMaintenanceJobs/', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(generatedObjectArb, { minLength: 0, maxLength: 14 }),
        reportModeArb,
        fc.integer({ min: 1, max: 4 }),
        async (generated, mode, pageSize) => {
          const fixture = buildFixture(generated);
          const log = createOperationLog();
          const bucket = createFakeBucket({ log, objects: fixture.objects });
          const db = createFakeFirestore({ log, collections: fixture.collections });
          const rtdb = createFakeRtdb({ log, tree: fixture.tree });

          const run = await runStorageOrphanSweep({
            db: db as never,
            rtdb: rtdb as never,
            bucket: bucket as never,
            config: sweepConfig({ ...mode, pageSize, nowMs: NOW }) as never,
          });

          const invoked = new Set(log.methods());

          // 1. No bucket mutator was even ASKED for.
          for (const method of FORBIDDEN_BUCKET_METHODS) {
            expect(invoked.has(method)).toBe(false);
          }

          // 2. No Realtime Database write.
          for (const method of FORBIDDEN_RTDB_METHODS) {
            expect(invoked.has(method)).toBe(false);
          }

          // 3. Every write that happened at all was the job's own bookkeeping.
          const foreignWrites = log
            .writes()
            .filter(
              (entry) =>
                entry.store !== 'firestore' || !entry.target.startsWith('storageMaintenanceJobs/')
            );
          expect(foreignWrites).toEqual([]);

          // 4. Specifically: the quota record is NOT written …
          expect(db.read(`tenantStorageUsage/${TENANT}`)).toBeUndefined();
          expect(
            log.writes().some((entry) => entry.target.startsWith('tenantStorageUsage/'))
          ).toBe(false);

          // … while the recomputed value IS recorded, on the result and on the
          // report document. The recompute is a read; recording it is not a
          // mutation of anything an application reads (Req 14.4).
          const [result] = run.tenants;
          expect(run.dryRun).toBe(true);
          expect(result.status).toBe('completed');
          expect(typeof result.usageBytesAfter).toBe('number');

          const report = db.read(tenantReportPath(TENANT));
          expect(report).toBeDefined();
          expect(report!.mode).toBe(mode.mode);
          expect(report!.applied).toBe(false);
          expect(typeof report!.usageBytesAfter).toBe('number');
          expect(report!.quarantinedCount).toBe(0);
          expect(report!.quarantineFailures).toBe(0);

          // 5. The bucket is byte-for-byte what it was: nothing moved, nothing
          //    vanished, however many objects were unreferenced.
          expect(bucket.contents().size).toBe(fixture.objects.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('mutates nothing even when every single object in the listing is unreferenced', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            category: fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
            slug: hexSlugArb,
            ageDays: fc.integer({ min: 8, max: 900 }),
            size: fc.integer({ min: 1, max: 1_000 }),
          }),
          { minLength: 1, maxLength: 12 }
        ),
        reportModeArb,
        async (entries, mode) => {
          const objects: FakeObject[] = entries.map((entry, index) => {
            const stamp = iso(NOW - entry.ageDays * DAY);
            return {
              name: `${entry.category}/${TENANT}/${entry.slug}_${index}.bin`,
              size: entry.size,
              timeCreated: stamp,
              updated: stamp,
            };
          });

          const log = createOperationLog();
          const bucket = createFakeBucket({ log, objects });
          // No reference source holds anything at all.
          const db = createFakeFirestore({ log, collections: {} });
          const rtdb = createFakeRtdb({ log, tree: {} });

          const run = await runStorageOrphanSweep({
            db: db as never,
            rtdb: rtdb as never,
            bucket: bucket as never,
            config: sweepConfig({ ...mode, nowMs: NOW, pageSize: 3 }) as never,
          });

          const [result] = run.tenants;
          // Every object is old, in scope and unreferenced — except the
          // profile-picture ones, whose filenames the derivation does not describe
          // and which are therefore retained as `unmanaged_path` (Req 7.9).
          const undescribedProfilePictures = objects.filter((object) =>
            object.name.startsWith(`profile-pictures/${TENANT}/`)
          ).length;
          expect(result.orphanCount).toBe(objects.length - undescribedProfilePictures);
          expect(result.retainedByReason.unmanaged_path).toBe(undescribedProfilePictures);

          // And still: no mutator of any kind, and the bucket is untouched.
          const invoked = new Set(log.methods());
          for (const method of [...FORBIDDEN_BUCKET_METHODS, ...FORBIDDEN_RTDB_METHODS]) {
            expect(invoked.has(method)).toBe(false);
          }
          expect(
            log
              .writes()
              .filter(
                (entry) =>
                  entry.store !== 'firestore' || !entry.target.startsWith('storageMaintenanceJobs/')
              )
          ).toEqual([]);
          expect(bucket.contents().size).toBe(objects.length);
          expect(db.read(`tenantStorageUsage/${TENANT}`)).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});

/** The bucket name the fixtures use, asserted so a rename cannot silently pass. */
it('resolves references against the configured bucket', () => {
  expect(downloadUrl('notices/acme/x.png')).toContain(BUCKET_NAME);
});
