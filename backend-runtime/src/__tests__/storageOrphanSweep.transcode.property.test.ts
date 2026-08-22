// Feature: storage-orphan-cleanup, Property 10: Transcode outputs are retained and expected-missing originals are not orphans
/**
 * Property 10: Transcode outputs are retained and expected-missing originals are
 * not orphans
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7**
 *
 * *For any* generated set of `videoTranscodes` documents — every combination of
 * `status` ∈ {`processing`, `done`, `skipped`, `error`, absent} ×
 * `originalDeleted` ∈ {`true`, `false`, absent} × `transcodedUrl`/`transcodedPath`
 * present or absent × `originalDeleteError` present or absent — crossed with
 * generated bucket listings:
 *
 *  - every existing object named by `transcodedPath` or resolved from
 *    `transcodedUrl` is retained, at EVERY status, `error` included;
 *  - every existing object named by `originalPath` is retained whenever
 *    `originalDeleted !== true`, and unconditionally when `status === 'processing'`;
 *  - for every chat video path in the retain set, the derived
 *    `buildTranscodeStoragePath(path)` is retained too, whether or not a
 *    `videoTranscodes` document exists for it;
 *  - **no `_h264.mp4` object whose document carries a `transcodedUrl` is ever
 *    reported.**
 *
 * ── Why `status` is not liveness ────────────────────────────────────────────
 *
 * The `status: 'error'` clause is not hypothetical. `/video/request-transcode`
 * returns any `transcodedUrl` it finds *regardless of status* and repairs the
 * status afterwards, so a document marked `error` can be serving a video right
 * now. Treating `status` as a liveness signal would delete videos that are being
 * watched, which is why it is explicitly generated here rather than left to a
 * comment.
 *
 * The `originalDeleted: true` clause is the mirror image: the transcoder deletes
 * the original on purpose, so its absence is EXPECTED and must produce no
 * Dangling_Reference — while an original that is nevertheless still present is a
 * genuine orphan that v1 reports and deliberately leaves in place, keeping the one
 * class of object the transcoder is entitled to remove out of two deleters' hands.
 */

import * as fc from 'fast-check';

import { buildTranscodeStoragePath } from '../videoTranscoder';
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
/** Old enough that only a reference can retain it — the grace period cannot. */
const OLD = iso(NOW - 400 * DAY);

type Status = 'processing' | 'done' | 'skipped' | 'error' | 'absent';
type OriginalDeleted = 'true' | 'false' | 'absent';

interface TranscodeCase {
  status: Status;
  originalDeleted: OriginalDeleted;
  transcodedPathPresent: boolean;
  transcodedUrlPresent: boolean;
  originalDeleteError: boolean;
  /** Whether the original object is actually in the bucket. */
  originalInBucket: boolean;
  /** Whether the output object is actually in the bucket. */
  outputInBucket: boolean;
  /** Whether a chat message also references the original, feeding the derivation. */
  referencedByChat: boolean;
}

const transcodeCaseArb: fc.Arbitrary<TranscodeCase> = fc.record({
  status: fc.constantFrom<Status>('processing', 'done', 'skipped', 'error', 'absent'),
  originalDeleted: fc.constantFrom<OriginalDeleted>('true', 'false', 'absent'),
  transcodedPathPresent: fc.boolean(),
  transcodedUrlPresent: fc.boolean(),
  originalDeleteError: fc.boolean(),
  originalInBucket: fc.boolean(),
  outputInBucket: fc.boolean(),
  referencedByChat: fc.boolean(),
});

interface BuiltCase extends TranscodeCase {
  index: number;
  originalPath: string;
  outputPath: string;
}

function build(cases: TranscodeCase[]): {
  built: BuiltCase[];
  objects: FakeObject[];
  collections: Record<string, Record<string, Record<string, unknown>>>;
  tree: Record<string, unknown>;
} {
  const built: BuiltCase[] = [];
  const objects: FakeObject[] = [];
  const videoTranscodes: Record<string, Record<string, unknown>> = {};
  const messages: Record<string, Record<string, unknown>> = {};

  cases.forEach((entry, index) => {
    const originalPath = `chat-files/${TENANT}/c_1/k_${String(index).padStart(3, '0')}_clip.mov`;
    const outputPath = buildTranscodeStoragePath(originalPath);
    built.push({ ...entry, index, originalPath, outputPath });

    if (entry.originalInBucket) {
      objects.push({ name: originalPath, size: 5_000 + index, timeCreated: OLD, updated: OLD });
    }
    if (entry.outputInBucket) {
      objects.push({ name: outputPath, size: 2_000 + index, timeCreated: OLD, updated: OLD });
    }

    videoTranscodes[`doc_${index}`] = {
      tenantId: TENANT,
      originalPath,
      originalUrl: downloadUrl(originalPath),
      ...(entry.status === 'absent' ? {} : { status: entry.status }),
      ...(entry.originalDeleted === 'absent'
        ? {}
        : { originalDeleted: entry.originalDeleted === 'true' }),
      ...(entry.transcodedPathPresent ? { transcodedPath: outputPath } : {}),
      ...(entry.transcodedUrlPresent ? { transcodedUrl: downloadUrl(outputPath) } : {}),
      ...(entry.originalDeleteError ? { originalDeleteError: 'delete failed: 503' } : {}),
    };

    if (entry.referencedByChat) {
      messages[`-msg_${String(index).padStart(4, '0')}`] = {
        sender: 'teacher@example.com',
        attachments: [{ url: downloadUrl(originalPath) }],
      };
    }
  });

  return {
    built,
    objects,
    collections: { videoTranscodes },
    tree: { tenantChat: { [TENANT]: { conversationMessages: { c_1: messages } } } },
  };
}

let consoleLog: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
});

describe('Property 10: transcode outputs are retained and expected-missing originals are not orphans', () => {
  it('honours all four retain rules across the full videoTranscodes matrix', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(transcodeCaseArb, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 4 }),
        async (cases, pageSize) => {
          const fixture = build(cases);
          const log = createOperationLog();
          const db = createFakeFirestore({ log, collections: fixture.collections });
          const run = await runStorageOrphanSweep({
            db: db as never,
            rtdb: createFakeRtdb({ log, tree: fixture.tree }) as never,
            bucket: createFakeBucket({ log, objects: fixture.objects }) as never,
            config: sweepConfig({ pageSize, nowMs: NOW }) as never,
          });

          const result = run.tenants[0];
          expect(result.status).toBe('completed');
          const reported = new Set(
            (db.read(tenantReportPath(TENANT))!.sampleOrphanPaths as string[]) ?? []
          );
          // Every candidate is in the sample: the fixtures are far below the 200 bound.
          expect(reported.size).toBe(result.orphanCount);

          for (const entry of fixture.built) {
            // Rule 1 — the OUTPUT is retained at every status, `error` included,
            // whenever the document names it at all.
            if (entry.outputInBucket && (entry.transcodedPathPresent || entry.transcodedUrlPresent)) {
              expect(reported.has(entry.outputPath)).toBe(false);
            }

            // The headline clause: no `_h264.mp4` whose document carries a
            // `transcodedUrl` is ever reported.
            if (entry.outputInBucket && entry.transcodedUrlPresent) {
              expect(reported.has(entry.outputPath)).toBe(false);
            }

            // Rule 2 — the ORIGINAL is retained unless its absence is expected …
            if (entry.originalInBucket && entry.originalDeleted !== 'true') {
              expect(reported.has(entry.originalPath)).toBe(false);
            }

            // Rule 3 — … and unconditionally while a transcode is in flight.
            if (entry.originalInBucket && entry.status === 'processing') {
              expect(reported.has(entry.originalPath)).toBe(false);
            }

            // Req 8.6 — an original the document says was deleted but which is
            // still present is a genuine orphan: reported, and left in place.
            // (Unless a chat message or the `processing` rule independently proves it.)
            if (
              entry.originalInBucket &&
              entry.originalDeleted === 'true' &&
              entry.status !== 'processing' &&
              !entry.referencedByChat
            ) {
              expect(reported.has(entry.originalPath)).toBe(true);
            }

            // Rule 4 — the output derived from a chat video path is retained even
            // when the document names no output at all, which is the window where
            // the object exists but neither the Firestore nor the RTDB write-back
            // has landed.
            if (
              entry.outputInBucket &&
              !entry.transcodedPathPresent &&
              !entry.transcodedUrlPresent &&
              (entry.referencedByChat || entry.originalDeleted !== 'true' || entry.status === 'processing')
            ) {
              expect(reported.has(entry.outputPath)).toBe(false);
            }
          }

          // Report mode: nothing moved.
          expect(
            log.writes().some((write) => write.store === 'bucket' || write.store === 'rtdb')
          ).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('records no dangling reference for an original whose absence is expected', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (count) => {
        const objects: FakeObject[] = [];
        const videoTranscodes: Record<string, Record<string, unknown>> = {};
        for (let index = 0; index < count; index += 1) {
          const originalPath = `chat-files/${TENANT}/c_1/k_${index}_clip.mov`;
          const outputPath = buildTranscodeStoragePath(originalPath);
          // The transcoder deleted the original on purpose: it is NOT in the bucket.
          objects.push({ name: outputPath, size: 1_000, timeCreated: OLD, updated: OLD });
          videoTranscodes[`doc_${index}`] = {
            tenantId: TENANT,
            status: 'done',
            originalPath,
            originalDeleted: true,
            transcodedPath: outputPath,
            transcodedUrl: downloadUrl(outputPath),
          };
        }

        const log = createOperationLog();
        const db = createFakeFirestore({ log, collections: { videoTranscodes } });
        const run = await runStorageOrphanSweep({
          db: db as never,
          rtdb: createFakeRtdb({ log, tree: {} }) as never,
          bucket: createFakeBucket({ log, objects }) as never,
          config: sweepConfig({ nowMs: NOW }) as never,
        });

        const result = run.tenants[0];
        // The outputs are retained, the originals were never offered, so nothing is
        // reported and nothing dangles: an expected-absent original is not a
        // dangling reference (Req 8.5).
        expect(result.orphanCount).toBe(0);
        expect(result.retainedByReason.referenced).toBe(count);
        expect(result.danglingReferenceCount).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});
