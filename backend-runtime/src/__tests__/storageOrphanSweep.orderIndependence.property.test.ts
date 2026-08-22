// Feature: storage-orphan-cleanup, Property 14: The retain set is immutable during listing
/**
 * Property 14: The retain set is immutable during listing
 * **Validates: Requirements 13.1, 13.2, 13.3**
 *
 * *For any* generated listing order and *any* page size over a fixed retain set,
 * the disposition of an object is a function of
 * `(objectPath, lastTouchedMs, retainPaths, graceCutoffMs)` alone — never of when
 * the object was reached. Concretely: shuffling the listing order and changing the
 * page size produce the **identical** partition of objects into retained and
 * reported.
 *
 * ── What this forbids ──────────────────────────────────────────────────────
 *
 * The tempting optimisation: noticing a reference while listing and adding it to
 * the retain set. Under that, two runs over the same bucket could disagree purely
 * on ordering — an object listed before its reference was noticed would be a
 * candidate, and the same object listed after would be retained. Making the retain
 * set immutable for the whole of Phase 2 is what rules that out, and the sweep
 * asserts the immutability at runtime once per page rather than only documenting
 * it.
 *
 * The fake bucket is asked to return a GENERATED order here, not its default
 * lexicographic one, so the property is asserted against orders the sweep did not
 * choose.
 */

import * as fc from 'fast-check';

import { STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';
import { runStorageOrphanSweep, tenantReportPath } from '../jobs/storageOrphanSweep';
import {
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

interface GeneratedObject {
  category: string;
  /** Days since the object was last touched; some inside the grace window. */
  ageDays: number;
  size: number;
  referenced: boolean;
  /** No timestamps at all ⇒ `age_unknown`, which must also be order-independent. */
  ageUnreadable: boolean;
}

const generatedObjectArb: fc.Arbitrary<GeneratedObject> = fc.record({
  category: fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
  ageDays: fc.integer({ min: 0, max: 60 }),
  size: fc.integer({ min: 0, max: 90_000 }),
  referenced: fc.boolean(),
  ageUnreadable: fc.boolean(),
});

interface Fixture {
  objects: FakeObject[];
  collections: Record<string, Record<string, Record<string, unknown>>>;
  tree: Record<string, unknown>;
}

function buildFixture(generated: GeneratedObject[]): Fixture {
  const objects: FakeObject[] = [];
  const notices: Record<string, Record<string, unknown>> = {};
  const messages: Record<string, Record<string, unknown>> = {};

  generated.forEach((entry, index) => {
    const objectPath = `${entry.category}/${TENANT}/obj_${String(index).padStart(3, '0')}.bin`;
    const stamp = iso(NOW - entry.ageDays * DAY);
    objects.push({
      name: objectPath,
      size: entry.size,
      ...(entry.ageUnreadable ? {} : { timeCreated: stamp, updated: stamp }),
    });
    if (entry.referenced) {
      // Alternate the proving source so the retain set is built from more than one
      // enumeration path, which is the realistic case.
      if (index % 2 === 0) {
        notices[`notice_${index}`] = { tenantId: TENANT, imageStoragePath: objectPath };
      } else {
        messages[`-msg_${String(index).padStart(4, '0')}`] = {
          sender: 'teacher@example.com',
          fileUrl: downloadUrl(objectPath),
        };
      }
    }
  });

  return {
    objects,
    collections: { notices },
    tree: { tenantChat: { [TENANT]: { conversationMessages: { c_1: messages } } } },
  };
}

interface Partition {
  retainedByReason: Record<string, number>;
  orphanCount: number;
  orphanBytes: number;
  objectsScanned: number;
  reported: string[];
  usageBytesAfter: number | null;
  referenceFingerprint: string;
}

async function sweepWith(fixture: Fixture, order: string[], pageSize: number): Promise<Partition> {
  const log = createOperationLog();
  // A FRESH progress store per run: this property is about ordering, not about the
  // completed-tenant no-op, which Property 7 owns.
  const db = createFakeFirestore({ log, collections: fixture.collections });
  const run = await runStorageOrphanSweep({
    db: db as never,
    rtdb: createFakeRtdb({ log, tree: fixture.tree }) as never,
    bucket: createFakeBucket({ log, objects: fixture.objects, order }) as never,
    config: sweepConfig({ pageSize, nowMs: NOW }) as never,
  });

  const result = run.tenants[0];
  const report = db.read(tenantReportPath(TENANT))!;
  return {
    retainedByReason: result.retainedByReason,
    orphanCount: result.orphanCount,
    orphanBytes: result.orphanBytes,
    objectsScanned: result.objectsScanned,
    reported: [...((report.sampleOrphanPaths as string[]) ?? [])].sort(),
    usageBytesAfter: result.usageBytesAfter,
    referenceFingerprint: report.referenceFingerprint as string,
  };
}

let consoleLog: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
});

describe('Property 14: the retain set is immutable during listing', () => {
  it('produces the identical retained/reported partition under any order and page size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(generatedObjectArb, { minLength: 1, maxLength: 14 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        async (generated, pageSizeA, pageSizeB) => {
          const fixture = buildFixture(generated);
          const names = fixture.objects.map((object) => object.name);

          // A lexicographic baseline, and two orders the sweep did not choose.
          const baseline = await sweepWith(fixture, [...names].sort(), pageSizeA);
          const reversed = await sweepWith(fixture, [...names].sort().reverse(), pageSizeB);
          const interleaved = await sweepWith(
            fixture,
            [
              ...names.filter((_, index) => index % 2 === 1),
              ...names.filter((_, index) => index % 2 === 0),
            ],
            pageSizeB
          );

          // Same objects examined, same partition, same bytes — three orders, two
          // page sizes.
          for (const other of [reversed, interleaved]) {
            expect(other.objectsScanned).toBe(baseline.objectsScanned);
            expect(other.retainedByReason).toEqual(baseline.retainedByReason);
            expect(other.orphanCount).toBe(baseline.orphanCount);
            expect(other.orphanBytes).toBe(baseline.orphanBytes);
            expect(other.reported).toEqual(baseline.reported);
            expect(other.usageBytesAfter).toBe(baseline.usageBytesAfter);
            // The retain set itself is identical, independently of insertion order.
            expect(other.referenceFingerprint).toBe(baseline.referenceFingerprint);
          }

          // Every object got exactly one disposition, and the two halves of the
          // partition cover the listing exactly.
          const retainedTotal = Object.values(baseline.retainedByReason).reduce(
            (total, count) => total + count,
            0
          );
          expect(retainedTotal + baseline.orphanCount).toBe(baseline.objectsScanned);
          expect(baseline.objectsScanned).toBe(fixture.objects.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});
