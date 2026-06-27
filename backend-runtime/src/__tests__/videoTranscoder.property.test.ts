// Feature: video-transcoding-compatibility, Property 13: tenantId is written to every videoTranscodes document

/**
 * Property 13: tenantId is written to every videoTranscodes document
 * Validates: Requirements 3.6
 *
 * For every valid non-empty tenantId string, when scheduleVideoTranscode is
 * called with a TranscodeJob that includes that tenantId, the Firestore
 * `set()` call for the document with status 'processing' MUST include a
 * `tenantId` field equal to the input value.
 */

import * as fc from 'fast-check';

// ─── Firestore mock ──────────────────────────────────────────────────────────

/** Capture every object passed to set() so we can assert on it later. */
const firestoreSetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];
const mockFirestoreDoc = {
  set: jest.fn((data: Record<string, unknown>, options?: unknown) => {
    firestoreSetCalls.push({ data, options });
    return Promise.resolve();
  }),
};
const mockFirestoreCollection = jest.fn().mockReturnValue({
  doc: jest.fn().mockReturnValue(mockFirestoreDoc),
});

// ─── Storage / child_process / fs mocks ─────────────────────────────────────

// bucket.file(...).download() — resolves without downloading anything
const mockFileDownload = jest.fn().mockResolvedValue(undefined);
// bucket.file(...).save() — resolves without uploading anything
const mockFileSave = jest.fn().mockResolvedValue(undefined);
// bucket.file(...).delete() — resolves without deleting anything
const mockFileDelete = jest.fn().mockResolvedValue(undefined);

const mockBucketFile = jest.fn().mockReturnValue({
  download: mockFileDownload,
  save: mockFileSave,
  delete: mockFileDelete,
});

// ─── Module-level jest.mock calls must be hoisted, so we mock before import ──

jest.mock('firebase-admin', () => ({
  firestore: Object.assign(
    jest.fn(() => ({
      collection: mockFirestoreCollection,
    })),
    {
      FieldValue: {
        serverTimestamp: jest.fn().mockReturnValue({ _methodName: 'serverTimestamp' }),
      },
    }
  ),
  storage: jest.fn(() => ({
    bucket: jest.fn().mockReturnValue({
      file: mockBucketFile,
    }),
  })),
}));

// child_process.execSync — used by probeInputVideo and probeVideo; return a valid HEVC probe result
jest.mock('child_process', () => ({
  execSync: jest.fn().mockReturnValue('hevc,yuv420p10le'),
  spawn: jest.fn(() => {
    const EventEmitter = require('events');
    const proc = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).stdin = null;
    // Emit 'close' with code 0 asynchronously — makes transcodeToH264 resolve
    process.nextTick(() => proc.emit('close', 0));
    return proc;
  }),
}));

// fs.readFileSync — return a non-empty buffer so Storage.save has something
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn().mockReturnValue(Buffer.alloc(2048, 0)),
  statSync: jest.fn().mockReturnValue({ size: 4096 }),
  unlinkSync: jest.fn(),
}));

// ─── Import the module under test after mocks are set up ────────────────────

import { scheduleVideoTranscode } from '../videoTranscoder';

// ─── Test helpers ────────────────────────────────────────────────────────────

/**
 * Run a single transcode job and wait for the first Firestore set() call
 * (the 'processing' status write) to complete. Since all mocks resolve
 * synchronously via Promises, polling with setImmediate flushes is fast.
 */
function runJobAndWaitForFirstWrite(
  job: Parameters<typeof scheduleVideoTranscode>[0]
): Promise<void> {
  return new Promise((resolve) => {
    const initialCount = firestoreSetCalls.length;
    scheduleVideoTranscode(job);

    // Poll until the first set() call for this job appears
    const poll = () => {
      if (firestoreSetCalls.length > initialCount) {
        resolve();
      } else {
        setImmediate(poll);
      }
    };
    setImmediate(poll);
  });
}

// ─── Property test ───────────────────────────────────────────────────────────

describe('Property 13 — tenantId is written to every videoTranscodes document', () => {
  beforeEach(() => {
    firestoreSetCalls.length = 0;
    jest.clearAllMocks();

    // Re-wire mocks that clearAllMocks() reset to their default (undefined) implementations
    mockFirestoreDoc.set.mockImplementation((data: Record<string, unknown>, options?: unknown) => {
      firestoreSetCalls.push({ data, options });
      return Promise.resolve();
    });

    const adminMock = require('firebase-admin');
    adminMock.firestore.mockReturnValue({ collection: mockFirestoreCollection });
    adminMock.storage.mockReturnValue({ bucket: jest.fn().mockReturnValue({ file: mockBucketFile }) });

    mockFirestoreCollection.mockReturnValue({ doc: jest.fn().mockReturnValue(mockFirestoreDoc) });
    mockBucketFile.mockReturnValue({
      download: mockFileDownload,
      save: mockFileSave,
      delete: mockFileDelete,
    });
    mockFileDownload.mockResolvedValue(undefined);
    mockFileSave.mockResolvedValue(undefined);
    mockFileDelete.mockResolvedValue(undefined);

    const cpMock = require('child_process');
    cpMock.execSync.mockReturnValue('hevc,yuv420p10le');
    cpMock.spawn.mockImplementation(() => {
      const EventEmitter = require('events');
      const proc = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    });

    const fsMock = require('fs');
    fsMock.readFileSync.mockReturnValue(Buffer.alloc(2048, 0));
    fsMock.unlinkSync.mockImplementation(() => undefined);
    fsMock.statSync = jest.fn().mockReturnValue({ size: 4096 });
  });

  it(
    'writes tenantId to the Firestore document for any non-empty tenantId (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1 }),
          async (tenantId) => {
            // Reset captured calls for each run
            firestoreSetCalls.length = 0;

            const job = {
              originalPath: `tenants/${tenantId}/videos/test.mov`,
              bucketName: 'test-bucket',
              originalUrl: `https://example.com/videos/test.mov`,
              contentType: 'video/quicktime',
              tenantId,
            };

            // Wait until the first Firestore set() (status: 'processing') is written
            await runJobAndWaitForFirstWrite(job);

            // Assert: the first set() call must include the correct tenantId field
            if (firestoreSetCalls.length === 0) {
              throw new Error(`No Firestore set() call was made for tenantId="${tenantId}"`);
            }

            const processingCall = firestoreSetCalls[0];
            const writtenTenantId = processingCall.data['tenantId'];

            if (writtenTenantId !== tenantId) {
              throw new Error(
                `Expected tenantId "${tenantId}" in first Firestore write, got "${writtenTenantId}". ` +
                `Full write data: ${JSON.stringify(processingCall.data)}`
              );
            }

            return true;
          }
        ),
        { numRuns: 25, verbose: false }
      );
    },
    // Generous timeout: 25 runs × async pipeline, all mocked but still async
    30_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: video-transcoding-compatibility, Property 23: Input file probe failure aborts transcoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property 23: Input file probe failure aborts transcoding
 * Validates: Requirements 6.5
 *
 * For every failure mode of the input probe step (ffprobe exits non-zero OR
 * ffprobe returns no video stream), `transcodeToH264` (child_process.spawn)
 * and Storage upload (bucket.file().save()) MUST NOT be called, and the
 * Firestore document MUST be updated with { status: 'error', error: 'probe_failed' }.
 */

type ProbeFailureMode = { exitCode: 1 } | { noStream: true };

describe('Property 23 — Input file probe failure aborts transcoding', () => {
  // Capture Firestore set() calls for this suite
  const p23SetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];

  /** Shared mock references (re-assigned in beforeEach after clearAllMocks) */
  let p23SpawnMock: jest.Mock;
  let p23SaveMock: jest.Mock;
  let p23DocSetMock: jest.Mock;

  beforeEach(() => {
    p23SetCalls.length = 0;
    jest.clearAllMocks();

    // Set up fresh mock implementations
    p23DocSetMock = jest.fn((data: Record<string, unknown>, options?: unknown) => {
      p23SetCalls.push({ data, options });
      return Promise.resolve();
    });

    p23SaveMock = jest.fn().mockResolvedValue(undefined);

    p23SpawnMock = jest.fn(() => {
      const EventEmitter = require('events');
      const proc = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    });

    const adminMock = require('firebase-admin');
    adminMock.firestore.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: p23DocSetMock }),
      }),
    });
    adminMock.storage.mockReturnValue({
      bucket: jest.fn().mockReturnValue({
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(undefined),
          save: p23SaveMock,
          delete: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    });

    const cpMock = require('child_process');
    // spawn reference is re-assigned per test case based on failure mode
    cpMock.spawn = p23SpawnMock;

    const fsMock = require('fs');
    fsMock.readFileSync.mockReturnValue(Buffer.alloc(2048, 0));
    fsMock.unlinkSync.mockImplementation(() => undefined);
    fsMock.statSync = jest.fn().mockReturnValue({ size: 4096 });
  });

  /**
   * Wait until the Firestore doc has an 'error' status write OR until a
   * timeout, whichever comes first.
   */
  function waitForErrorWrite(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const hasErrorWrite = p23SetCalls.some(
          (c) => c.data['status'] === 'error' || c.data['status'] === 'processing'
        );
        if (hasErrorWrite) return resolve();
        if (Date.now() > deadline) return reject(new Error('Timed out waiting for Firestore error write'));
        setImmediate(poll);
      };
      setImmediate(poll);
    });
  }

  it(
    'spawn (transcodeToH264) and save (Storage upload) are never called when probe fails (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant<ProbeFailureMode>({ exitCode: 1 }),
            fc.constant<ProbeFailureMode>({ noStream: true })
          ),
          async (failureMode) => {
            // Reset per-run state
            p23SetCalls.length = 0;
            p23SpawnMock.mockClear();
            p23SaveMock.mockClear();
            p23DocSetMock.mockClear();

            // Re-wire doc set mock after clear
            p23DocSetMock.mockImplementation((data: Record<string, unknown>, options?: unknown) => {
              p23SetCalls.push({ data, options });
              return Promise.resolve();
            });

            // Configure execSync based on the failure mode
            const cpMock = require('child_process');
            if ('exitCode' in failureMode) {
              // Simulate ffprobe exiting with non-zero code → execSync throws
              cpMock.execSync = jest.fn().mockImplementation(() => {
                const err: NodeJS.ErrnoException = new Error('ffprobe exited with code 1');
                (err as any).status = 1;
                throw err;
              });
            } else {
              // Simulate ffprobe returning empty output → no video stream found
              cpMock.execSync = jest.fn().mockReturnValue('');
            }
            cpMock.spawn = p23SpawnMock;

            // Re-wire firebase-admin mocks so the fresh doc mock is used
            const adminMock = require('firebase-admin');
            adminMock.firestore.mockReturnValue({
              collection: jest.fn().mockReturnValue({
                doc: jest.fn().mockReturnValue({ set: p23DocSetMock }),
              }),
            });
            adminMock.storage.mockReturnValue({
              bucket: jest.fn().mockReturnValue({
                file: jest.fn().mockReturnValue({
                  download: jest.fn().mockResolvedValue(undefined),
                  save: p23SaveMock,
                  delete: jest.fn().mockResolvedValue(undefined),
                }),
              }),
            });

            // statSync is called right after download to get the original file size;
            // mock it to return a plausible size so the probe path is reached.
            const fsMock = require('fs');
            fsMock.statSync = jest.fn().mockReturnValue({ size: 4096 });

            const job = {
              originalPath: 'tenants/test-tenant/videos/input.mov',
              bucketName: 'test-bucket',
              originalUrl: 'https://example.com/videos/input.mov',
              contentType: 'video/quicktime',
              tenantId: 'test-tenant',
            };

            scheduleVideoTranscode(job);
            await waitForErrorWrite();

            // Assert: spawn (ffmpeg) was never invoked
            if (p23SpawnMock.mock.calls.length > 0) {
              throw new Error(
                `Expected child_process.spawn (transcodeToH264/ffmpeg) NOT to be called on probe failure ` +
                `(mode: ${JSON.stringify(failureMode)}), but it was called ${p23SpawnMock.mock.calls.length} time(s).`
              );
            }

            // Assert: bucket.file().save() was never invoked
            if (p23SaveMock.mock.calls.length > 0) {
              throw new Error(
                `Expected bucket.file().save() (Storage upload) NOT to be called on probe failure ` +
                `(mode: ${JSON.stringify(failureMode)}), but it was called ${p23SaveMock.mock.calls.length} time(s).`
              );
            }

            // Assert: Firestore doc has status: 'error' and error: 'probe_failed'
            const errorWrite = p23SetCalls.find((c) => c.data['status'] === 'error');
            if (!errorWrite) {
              throw new Error(
                `Expected a Firestore set() with status: 'error' for probe failure ` +
                `(mode: ${JSON.stringify(failureMode)}). Calls: ${JSON.stringify(p23SetCalls)}`
              );
            }
            if (errorWrite.data['error'] !== 'probe_failed') {
              throw new Error(
                `Expected error: 'probe_failed' in Firestore write, got error: '${errorWrite.data['error']}' ` +
                `(mode: ${JSON.stringify(failureMode)})`
              );
            }

            return true;
          }
        ),
        { numRuns: 20, verbose: false }
      );
    },
    30_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: video-transcoding-compatibility, Property 21: ffprobe verification passes for all correctly transcoded files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property 21: ffprobe verification passes for all correctly transcoded files
 * Validates: Requirements 6.1, 6.4
 *
 * For any output file path, when `child_process.execSync` returns a valid
 * h264/yuv420p ffprobe output (bit depth 8, since 'yuv420p' contains no '10'),
 * `verifyOutputFile` SHALL return { codec: 'h264', pixFmt: 'yuv420p', bitDepth: 8 }
 * without throwing.
 */

describe('Property 21 — ffprobe verification passes for all correctly transcoded files', () => {
  let originalExecSync: unknown;

  beforeEach(() => {
    // Save current execSync mock state
    const cpMock = require('child_process');
    originalExecSync = cpMock.execSync;

    // Override execSync to return valid h264/yuv420p output for verifyOutputFile
    cpMock.execSync = jest.fn().mockReturnValue('h264,yuv420p');
  });

  afterEach(() => {
    // Restore previous execSync implementation
    const cpMock = require('child_process');
    cpMock.execSync = originalExecSync;
  });

  it(
    'verifyOutputFile returns { codec: h264, pixFmt: yuv420p, bitDepth: 8 } for any output path (property)',
    () => {
      // Import verifyOutputFile — the module is already loaded via the mock setup above
      const { verifyOutputFile } = require('../videoTranscoder');

      fc.assert(
        fc.property(
          fc.record({ outputPath: fc.string({ minLength: 1 }) }),
          ({ outputPath }) => {
            let result: { codec: string; pixFmt: string; bitDepth: number };

            // Should not throw for valid h264/yuv420p output
            expect(() => {
              result = verifyOutputFile(outputPath);
            }).not.toThrow();

            // Should return the correct probe info
            expect(result!.codec).toBe('h264');
            expect(result!.pixFmt).toBe('yuv420p');
            expect(result!.bitDepth).toBe(8);

            return true;
          }
        ),
        { numRuns: 50, verbose: false }
      );
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: video-transcoding-compatibility, Property 22: Any ffprobe verification failure prevents upload and records error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property 22: Any ffprobe verification failure prevents upload and records error
 * Validates: Requirements 6.2, 6.3
 *
 * For any combination of ffprobe output that fails verification (wrong codec,
 * wrong pixFmt, wrong bitDepth, or file size < 1024 bytes), runTranscodeJob
 * SHALL NOT call `bucket.file().save()` and the Firestore document SHALL have
 * `status: 'error'` and `error: 'output_verification_failed'`.
 */

describe('Property 22 — Any ffprobe verification failure prevents upload and records error', () => {
  // Capture Firestore set() calls for this suite
  const p22SetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];

  let p22SaveMock: jest.Mock;
  let p22DocSetMock: jest.Mock;
  let p22SpawnMock: jest.Mock;

  beforeEach(() => {
    p22SetCalls.length = 0;
    jest.clearAllMocks();

    p22DocSetMock = jest.fn((data: Record<string, unknown>, options?: unknown) => {
      p22SetCalls.push({ data, options });
      return Promise.resolve();
    });

    p22SaveMock = jest.fn().mockResolvedValue(undefined);

    p22SpawnMock = jest.fn(() => {
      const EventEmitter = require('events');
      const proc = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      // Emit close with code 0 so transcodeToH264 resolves successfully
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    });

    const adminMock = require('firebase-admin');
    adminMock.firestore.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: p22DocSetMock }),
      }),
    });
    adminMock.storage.mockReturnValue({
      bucket: jest.fn().mockReturnValue({
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(undefined),
          save: p22SaveMock,
          delete: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    });

    const cpMock = require('child_process');
    cpMock.spawn = p22SpawnMock;

    const fsMock = require('fs');
    fsMock.readFileSync.mockReturnValue(Buffer.alloc(2048, 0));
    fsMock.unlinkSync.mockImplementation(() => undefined);
  });

  /**
   * Wait until a Firestore write with status 'error' appears, or the
   * first 'processing' write (to detect the job has at least started),
   * then keep polling until 'error' appears or timeout.
   */
  function waitForErrorWrite(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const hasError = p22SetCalls.some((c) => c.data['status'] === 'error');
        if (hasError) return resolve();
        if (Date.now() > deadline) {
          return reject(
            new Error(
              `Timed out waiting for Firestore error write. Calls so far: ${JSON.stringify(p22SetCalls)}`
            )
          );
        }
        setImmediate(poll);
      };
      setImmediate(poll);
    });
  }

  it(
    'bucket.file().save() is never called and Firestore records error for any failing verification (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generator: any combination of codec/pixFmt/bitDepth/sizeBytes
          // filtered so that at least one verification condition fails.
          fc
            .record({
              codec: fc.string(),
              pixFmt: fc.string(),
              bitDepth: fc.nat(),
              sizeBytes: fc.nat({ max: 2000 }),
            })
            .filter(({ codec, pixFmt, bitDepth, sizeBytes }) => {
              const isWrongCodec = codec !== 'h264';
              const isWrongPixFmt = pixFmt !== 'yuv420p';
              // verifyOutputFile infers bitDepth as 10 if pixFmt contains '10', else 8
              const inferredBitDepth = pixFmt.includes('10') ? 10 : 8;
              const isWrongBitDepth = inferredBitDepth !== 8;
              const isTooSmall = sizeBytes < 1024;
              return isWrongCodec || isWrongPixFmt || isWrongBitDepth || isTooSmall;
            }),
          async ({ codec, pixFmt, sizeBytes }) => {
            // Reset per-run state
            p22SetCalls.length = 0;
            p22SaveMock.mockClear();
            p22DocSetMock.mockClear();
            p22DocSetMock.mockImplementation((data: Record<string, unknown>, options?: unknown) => {
              p22SetCalls.push({ data, options });
              return Promise.resolve();
            });

            const adminMock = require('firebase-admin');
            adminMock.firestore.mockReturnValue({
              collection: jest.fn().mockReturnValue({
                doc: jest.fn().mockReturnValue({ set: p22DocSetMock }),
              }),
            });
            adminMock.storage.mockReturnValue({
              bucket: jest.fn().mockReturnValue({
                file: jest.fn().mockReturnValue({
                  download: jest.fn().mockResolvedValue(undefined),
                  save: p22SaveMock,
                  delete: jest.fn().mockResolvedValue(undefined),
                }),
              }),
            });

            const cpMock = require('child_process');
            // Call sequence:
            //   1st execSync = probeInputVideo  → return 'hevc,yuv420p' (HEVC → needsTranscoding = true)
            //   2nd execSync = verifyOutputFile → return `${codec},${pixFmt}` (failing output)
            let execSyncCallCount = 0;
            cpMock.execSync = jest.fn().mockImplementation(() => {
              execSyncCallCount++;
              if (execSyncCallCount === 1) {
                // Input probe succeeds: HEVC source forces needsTranscoding → true
                return 'hevc,yuv420p';
              }
              // Output verification probe: returns the generated (possibly bad) codec/pixFmt
              return `${codec},${pixFmt}`;
            });
            cpMock.spawn = p22SpawnMock;

            // fs.statSync returns the generated sizeBytes for the output file
            const fsMock = require('fs');
            fsMock.statSync = jest.fn().mockReturnValue({ size: sizeBytes });
            fsMock.readFileSync.mockReturnValue(Buffer.alloc(Math.max(sizeBytes, 1), 0));
            fsMock.unlinkSync.mockImplementation(() => undefined);

            const job = {
              originalPath: 'tenants/test-tenant/videos/input.mov',
              bucketName: 'test-bucket',
              originalUrl: 'https://example.com/videos/input.mov',
              contentType: 'video/quicktime',
              tenantId: 'test-tenant',
            };

            scheduleVideoTranscode(job);
            await waitForErrorWrite();

            // Assert: bucket.file().save() (Storage upload) was NOT called
            if (p22SaveMock.mock.calls.length > 0) {
              throw new Error(
                `Expected bucket.file().save() NOT to be called when output verification fails ` +
                `(codec="${codec}", pixFmt="${pixFmt}", sizeBytes=${sizeBytes}), ` +
                `but it was called ${p22SaveMock.mock.calls.length} time(s).`
              );
            }

            // Assert: Firestore doc has status: 'error' and error: 'output_verification_failed'
            const errorWrite = p22SetCalls.find((c) => c.data['status'] === 'error');
            if (!errorWrite) {
              throw new Error(
                `Expected a Firestore set() with status: 'error' when output verification fails ` +
                `(codec="${codec}", pixFmt="${pixFmt}", sizeBytes=${sizeBytes}). ` +
                `Calls: ${JSON.stringify(p22SetCalls)}`
              );
            }
            if (errorWrite.data['error'] !== 'output_verification_failed') {
              throw new Error(
                `Expected error: 'output_verification_failed' in Firestore write, ` +
                `got error: '${errorWrite.data['error']}' ` +
                `(codec="${codec}", pixFmt="${pixFmt}", sizeBytes=${sizeBytes})`
              );
            }

            return true;
          }
        ),
        { numRuns: 30, verbose: false }
      );
    },
    40_000
  );
});


// ─────────────────────────────────────────────────────────────────────────────
// Feature: video-transcoding-compatibility, Property 12: Skipped transcodes leave quota unchanged
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property 12: Skipped transcodes leave quota unchanged
 * Validates: Requirements 3.5
 *
 * When `needsTranscoding` returns false (video is already H.264/8-bit in an
 * mp4 container), the Transcoder SHALL NOT call any quota function.
 * Specifically, `db.runTransaction` MUST NOT be called, and the Firestore
 * document MUST be updated with `status: 'skipped'`.
 */

describe('Property 12 — Skipped transcodes leave quota unchanged', () => {
  // Capture Firestore set() calls and runTransaction calls
  const p12SetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];
  let p12RunTransactionMock: jest.Mock;
  let p12DocSetMock: jest.Mock;

  beforeEach(() => {
    p12SetCalls.length = 0;
    jest.clearAllMocks();

    p12DocSetMock = jest.fn((data: Record<string, unknown>, options?: unknown) => {
      p12SetCalls.push({ data, options });
      return Promise.resolve();
    });

    // runTransaction is used exclusively by reserveTenantStorageBytes and
    // releaseTenantStorageBytes — it must never be called on the skipped path.
    p12RunTransactionMock = jest.fn().mockResolvedValue(undefined);

    const adminMock = require('firebase-admin');
    adminMock.firestore.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: p12DocSetMock }),
      }),
      runTransaction: p12RunTransactionMock,
    });
    adminMock.storage.mockReturnValue({
      bucket: jest.fn().mockReturnValue({
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(undefined),
          save: jest.fn().mockResolvedValue(undefined),
          delete: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    });

    // execSync returns 'h264,yuv420p' → codec='h264', bitDepth=8
    // needsTranscoding returns false for h264 + bitDepth 8 + contentType 'video/mp4'
    const cpMock = require('child_process');
    cpMock.execSync = jest.fn().mockReturnValue('h264,yuv420p');
    // spawn should not be reached; wire it up defensively
    cpMock.spawn = jest.fn(() => {
      const EventEmitter = require('events');
      const proc = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    });

    const fsMock = require('fs');
    fsMock.readFileSync.mockReturnValue(Buffer.alloc(2048, 0));
    fsMock.unlinkSync.mockImplementation(() => undefined);
    fsMock.statSync = jest.fn().mockReturnValue({ size: 4096 });
  });

  /**
   * Wait until the Firestore doc gets a 'skipped' status write OR a timeout.
   */
  function waitForSkippedWrite(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const hasSkipped = p12SetCalls.some((c) => c.data['status'] === 'skipped');
        if (hasSkipped) return resolve();
        if (Date.now() > deadline) {
          return reject(
            new Error(
              `Timed out waiting for Firestore 'skipped' write. Calls so far: ${JSON.stringify(p12SetCalls)}`
            )
          );
        }
        setImmediate(poll);
      };
      setImmediate(poll);
    });
  }

  it(
    'runTransaction is never called and status is skipped when video already needs no transcoding (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            tenantId: fc.string({ minLength: 1 }),
            originalPath: fc.string({ minLength: 1 }),
          }),
          async ({ tenantId, originalPath }) => {
            // Reset per-run state
            p12SetCalls.length = 0;
            p12RunTransactionMock.mockClear();
            p12DocSetMock.mockClear();
            p12DocSetMock.mockImplementation((data: Record<string, unknown>, options?: unknown) => {
              p12SetCalls.push({ data, options });
              return Promise.resolve();
            });

            // Re-wire admin mock so runTransaction is tracked for this run
            const adminMock = require('firebase-admin');
            adminMock.firestore.mockReturnValue({
              collection: jest.fn().mockReturnValue({
                doc: jest.fn().mockReturnValue({ set: p12DocSetMock }),
              }),
              runTransaction: p12RunTransactionMock,
            });
            adminMock.storage.mockReturnValue({
              bucket: jest.fn().mockReturnValue({
                file: jest.fn().mockReturnValue({
                  download: jest.fn().mockResolvedValue(undefined),
                  save: jest.fn().mockResolvedValue(undefined),
                  delete: jest.fn().mockResolvedValue(undefined),
                }),
              }),
            });

            // execSync always returns 'h264,yuv420p' → needsTranscoding returns false
            const cpMock = require('child_process');
            cpMock.execSync = jest.fn().mockReturnValue('h264,yuv420p');

            const fsMock = require('fs');
            fsMock.statSync = jest.fn().mockReturnValue({ size: 4096 });

            const job = {
              originalPath: originalPath || 'tenants/t/videos/v.mp4',
              bucketName: 'test-bucket',
              originalUrl: 'https://example.com/videos/v.mp4',
              contentType: 'video/mp4',
              tenantId,
            };

            scheduleVideoTranscode(job);
            await waitForSkippedWrite();

            // Assert: runTransaction (quota operations) was NEVER called
            if (p12RunTransactionMock.mock.calls.length > 0) {
              throw new Error(
                `Expected db.runTransaction NOT to be called when video skips transcoding ` +
                `(tenantId="${tenantId}"), but it was called ${p12RunTransactionMock.mock.calls.length} time(s).`
              );
            }

            // Assert: Firestore document has status: 'skipped'
            const skippedWrite = p12SetCalls.find((c) => c.data['status'] === 'skipped');
            if (!skippedWrite) {
              throw new Error(
                `Expected a Firestore set() with status: 'skipped' when video needs no transcoding ` +
                `(tenantId="${tenantId}"). Calls: ${JSON.stringify(p12SetCalls)}`
              );
            }

            return true;
          }
        ),
        { numRuns: 25, verbose: false }
      );
    },
    30_000
  );
});


// ─────────────────────────────────────────────────────────────────────────────
// Feature: video-transcoding-compatibility, Property 11: Quota reflects net replacement (increment H.264, decrement original)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property 11: Quota reflects net replacement (increment H.264, decrement original)
 * Validates: Requirements 3.2, 3.3
 *
 * For any (originalBytes, h264Bytes) pair, after a successful transcode the
 * `tenantStorageUsage.bytes` value MUST equal `before + h264Bytes - originalBytes`
 * and at no intermediate step SHALL the quota drop below `before`.
 *
 * Implementation:
 * - Mock Firestore `runTransaction` to track every `tx.set(usageRef, { bytes: N })`
 *   call in sequence, starting from a fixed `before` value.
 * - Mock `fs.statSync` so that:
 *     - first call (inputTmp)  → { size: originalBytes }
 *     - second call (outputTmp) → { size: h264Bytes }
 * - Mock `child_process.execSync`:
 *     - 1st call (probeInputVideo)   → 'hevc,yuv420p' (HEVC input → needsTranscoding = true)
 *     - 2nd call (verifyOutputFile)  → 'h264,yuv420p' (valid output)
 * - Mock `child_process.spawn` (ffmpeg) → closes with code 0
 * - After the job completes, assert on the recorded `bytes` sequence.
 */

describe('Property 11 — Quota reflects net replacement (increment H.264, decrement original)', () => {
  // Fixed "before" value so we can reason about relative changes
  const BEFORE_BYTES = 1_000_000;

  /** Bytes values written to tenantStorageUsage doc inside runTransaction, in order. */
  let quotaBytesSequence: number[] = [];

  /** Reference to the save mock so we can verify upload happens (sanity check). */
  let p11SaveMock: jest.Mock;
  let p11DocSetMock: jest.Mock;
  const p11SetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];

  /**
   * Build a fresh `runTransaction` mock that:
   * 1. Calls the transaction callback with a fake `tx` object.
   * 2. The fake `tx.get(ref)` resolves with a snapshot whose `.data()` returns
   *    the current simulated quota state.
   * 3. The fake `tx.set(ref, data)` updates the simulated state and records
   *    the new `bytes` value in `quotaBytesSequence`.
   */
  function buildRunTransactionMock() {
    // The simulated current bytes in tenantStorageUsage — starts at BEFORE_BYTES
    let currentBytes = BEFORE_BYTES;

    return jest.fn(async (callback: (tx: any) => Promise<void>) => {
      const fakeTx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ bytes: currentBytes }),
        }),
        set: jest.fn((ref: unknown, data: Record<string, unknown>) => {
          if (typeof data['bytes'] === 'number') {
            currentBytes = data['bytes'] as number;
            quotaBytesSequence.push(currentBytes);
          }
        }),
      };
      await callback(fakeTx);
    });
  }

  beforeEach(() => {
    quotaBytesSequence = [];
    p11SetCalls.length = 0;
    jest.clearAllMocks();

    p11SaveMock = jest.fn().mockResolvedValue(undefined);

    p11DocSetMock = jest.fn((data: Record<string, unknown>, options?: unknown) => {
      p11SetCalls.push({ data, options });
      return Promise.resolve();
    });

    // firebase-admin mock: firestore with runTransaction + collection/doc for status writes
    const adminMock = require('firebase-admin');
    const runTransactionMock = buildRunTransactionMock();

    adminMock.firestore.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: p11DocSetMock }),
      }),
      runTransaction: runTransactionMock,
    });
    adminMock.storage.mockReturnValue({
      bucket: jest.fn().mockReturnValue({
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(undefined),
          save: p11SaveMock,
          delete: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    });

    // child_process mocks
    const cpMock = require('child_process');
    let execSyncCallCount = 0;
    cpMock.execSync = jest.fn().mockImplementation(() => {
      execSyncCallCount++;
      // 1st call: probeInputVideo → HEVC (forces needsTranscoding = true)
      // 2nd call: verifyOutputFile → valid H.264 output
      return execSyncCallCount === 1 ? 'hevc,yuv420p' : 'h264,yuv420p';
    });
    cpMock.spawn = jest.fn(() => {
      const EventEmitter = require('events');
      const proc = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    });

    // fs mocks — statSync call order:
    //   1st call: inputTmp  (originalFileSizeBytes) → set per-test below via mockImplementation
    //   2nd call: outputTmp (outputFileSizeBytes)   → set per-test below via mockImplementation
    const fsMock = require('fs');
    fsMock.readFileSync.mockReturnValue(Buffer.alloc(2048, 0));
    fsMock.unlinkSync.mockImplementation(() => undefined);
    // Default statSync — overridden per property run below
    fsMock.statSync = jest.fn().mockReturnValue({ size: 4096 });
  });

  /**
   * Wait until the Firestore status write reaches 'done' or 'error',
   * meaning the full job pipeline has completed.
   */
  function waitForJobCompletion(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const isDone = p11SetCalls.some(
          (c) => c.data['status'] === 'done' || c.data['status'] === 'error'
        );
        if (isDone) return resolve();
        if (Date.now() > deadline) {
          return reject(
            new Error(
              `Timed out waiting for job completion. Set calls so far: ${JSON.stringify(p11SetCalls)}`
            )
          );
        }
        setImmediate(poll);
      };
      setImmediate(poll);
    });
  }

  it(
    'final quota equals before + h264Bytes − originalBytes and never drops below before (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generator: [originalBytes, h264Bytes] — both non-negative integers
          // Use nat({ max: 50_000_000 }) to keep sizes realistic and avoid overflow
          fc.tuple(
            fc.nat({ max: 50_000_000 }),
            // h264Bytes must be >= 1024 so verifyOutputFile's size check passes
            fc.integer({ min: 1024, max: 50_000_000 })
          ),
          async ([originalBytes, h264Bytes]) => {
            // Reset per-run tracking
            quotaBytesSequence = [];
            p11SetCalls.length = 0;
            p11SaveMock.mockClear();
            p11DocSetMock.mockClear();

            // Build a fresh runTransaction mock for this run (resets currentBytes to BEFORE_BYTES)
            let currentBytes = BEFORE_BYTES;
            const runTransactionMock = jest.fn(async (callback: (tx: any) => Promise<void>) => {
              const fakeTx = {
                get: jest.fn().mockResolvedValue({
                  exists: true,
                  data: () => ({ bytes: currentBytes }),
                }),
                set: jest.fn((ref: unknown, data: Record<string, unknown>) => {
                  if (typeof data['bytes'] === 'number') {
                    currentBytes = data['bytes'] as number;
                    quotaBytesSequence.push(currentBytes);
                  }
                }),
              };
              await callback(fakeTx);
            });

            p11DocSetMock.mockImplementation((data: Record<string, unknown>, options?: unknown) => {
              p11SetCalls.push({ data, options });
              return Promise.resolve();
            });

            const adminMock = require('firebase-admin');
            adminMock.firestore.mockReturnValue({
              collection: jest.fn().mockReturnValue({
                doc: jest.fn().mockReturnValue({ set: p11DocSetMock }),
              }),
              runTransaction: runTransactionMock,
            });
            adminMock.storage.mockReturnValue({
              bucket: jest.fn().mockReturnValue({
                file: jest.fn().mockReturnValue({
                  download: jest.fn().mockResolvedValue(undefined),
                  save: p11SaveMock,
                  delete: jest.fn().mockResolvedValue(undefined),
                }),
              }),
            });

            // Reset execSync call counter for this run
            const cpMock = require('child_process');
            let execSyncCallCount = 0;
            cpMock.execSync = jest.fn().mockImplementation(() => {
              execSyncCallCount++;
              return execSyncCallCount === 1 ? 'hevc,yuv420p' : 'h264,yuv420p';
            });
            cpMock.spawn = jest.fn(() => {
              const EventEmitter = require('events');
              const proc = new EventEmitter();
              (proc as any).stderr = new EventEmitter();
              process.nextTick(() => proc.emit('close', 0));
              return proc;
            });

            // statSync: 1st call → originalBytes (inputTmp), 2nd call → h264Bytes (outputTmp)
            const fsMock = require('fs');
            let statSyncCallCount = 0;
            fsMock.statSync = jest.fn().mockImplementation(() => {
              statSyncCallCount++;
              return statSyncCallCount === 1
                ? { size: originalBytes }
                : { size: h264Bytes };
            });
            fsMock.readFileSync.mockReturnValue(Buffer.alloc(Math.max(h264Bytes, 1024), 0));
            fsMock.unlinkSync.mockImplementation(() => undefined);

            const job = {
              originalPath: 'tenants/test-tenant/videos/input.mov',
              bucketName: 'test-bucket',
              originalUrl: 'https://example.com/videos/input.mov',
              contentType: 'video/quicktime',
              tenantId: 'test-tenant',
            };

            scheduleVideoTranscode(job);
            await waitForJobCompletion();

            // ── Assertion 1: at least one quota transaction occurred ──────────
            // releaseTenantStorageBytes has an early-return guard when decrementBytes <= 0,
            // so when originalBytes === 0 only 1 transaction (the increment) runs.
            // When originalBytes > 0, exactly 2 transactions run.
            const expectedTransactionCount = originalBytes > 0 ? 2 : 1;
            if (quotaBytesSequence.length !== expectedTransactionCount) {
              throw new Error(
                `Expected ${expectedTransactionCount} quota transaction(s), got ${quotaBytesSequence.length}. ` +
                `Sequence: [${quotaBytesSequence.join(', ')}] ` +
                `(originalBytes=${originalBytes}, h264Bytes=${h264Bytes})`
              );
            }

            // ── Assertion 2: first transaction is the increment (reserve h264Bytes) ──
            const afterIncrement = quotaBytesSequence[0];
            const expectedAfterIncrement = BEFORE_BYTES + h264Bytes;
            if (afterIncrement !== expectedAfterIncrement) {
              throw new Error(
                `Expected quota after increment = before(${BEFORE_BYTES}) + h264Bytes(${h264Bytes}) = ${expectedAfterIncrement}, ` +
                `got ${afterIncrement}. ` +
                `(originalBytes=${originalBytes}, h264Bytes=${h264Bytes})`
              );
            }

            // ── Assertion 3: final value equals before + h264Bytes − originalBytes ──
            const finalBytes = quotaBytesSequence[quotaBytesSequence.length - 1];
            // releaseTenantStorageBytes floors at 0 to prevent negative values
            const expectedFinal = Math.max(0, BEFORE_BYTES + h264Bytes - originalBytes);
            if (finalBytes !== expectedFinal) {
              throw new Error(
                `Expected final quota = max(0, before(${BEFORE_BYTES}) + h264Bytes(${h264Bytes}) − originalBytes(${originalBytes})) = ${expectedFinal}, ` +
                `got ${finalBytes}. ` +
                `Sequence: [${quotaBytesSequence.join(', ')}]`
              );
            }

            // ── Assertion 4: the first transaction (increment) must not drop below BEFORE_BYTES ──
            // The increment always happens before the decrement (Req 3.3).
            // The first recorded value MUST be `before + h264Bytes` (≥ before).
            // The final value MAY legitimately be less than `before` when
            // originalBytes > h264Bytes (the H.264 file is smaller than the original),
            // but the ORDER of operations must always be increment-first.
            //
            // "Never drops below before" means: at no point BEFORE the decrement
            // step does quota dip below `before`. Since increment is step 1 and
            // decrement is step 2, we only need to verify that step 1 ≥ before.
            const incrementValue = quotaBytesSequence[0];
            if (incrementValue < BEFORE_BYTES) {
              throw new Error(
                `First quota transaction (increment) produced a value below before(${BEFORE_BYTES}). ` +
                `This means the increment did not happen first or was negative. ` +
                `Sequence: [${quotaBytesSequence.join(', ')}] ` +
                `(originalBytes=${originalBytes}, h264Bytes=${h264Bytes})`
              );
            }

            return true;
          }
        ),
        { numRuns: 30, verbose: false }
      );
    },
    60_000
  );
});


// ─────────────────────────────────────────────────────────────────────────────
// Feature: video-transcoding-compatibility, Property 10: Successful transcode deletes original and marks originalDeleted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property 10: Successful transcode deletes original and marks originalDeleted
 * Validates: Requirements 3.1
 *
 * For any TranscodeJob with a non-empty originalPath and bucketName, when the
 * full transcode pipeline completes successfully (HEVC input → H.264 output,
 * valid ffprobe verification, successful Storage upload), the Transcoder SHALL:
 *   1. Call `bucket.file(originalPath).delete()` to remove the original file.
 *   2. Write `{ originalDeleted: true }` to the `videoTranscodes` Firestore document.
 */

describe('Property 10 — Successful transcode deletes original and marks originalDeleted', () => {
  const p10SetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];
  /** All paths passed to bucket.file(...).delete(), in call order. */
  const p10DeletedPaths: string[] = [];

  let p10DocSetMock: jest.Mock;
  let p10DeleteMock: jest.Mock;
  let p10BucketFileMock: jest.Mock;

  beforeEach(() => {
    p10SetCalls.length = 0;
    p10DeletedPaths.length = 0;
    jest.clearAllMocks();

    p10DocSetMock = jest.fn((data: Record<string, unknown>, options?: unknown) => {
      p10SetCalls.push({ data, options });
      return Promise.resolve();
    });

    // delete mock records which path was deleted
    p10DeleteMock = jest.fn().mockResolvedValue(undefined);

    // bucket.file(path) returns an object whose .delete() records the path
    p10BucketFileMock = jest.fn().mockImplementation((filePath: string) => ({
      download: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockImplementation(() => {
        p10DeletedPaths.push(filePath);
        return Promise.resolve();
      }),
    }));

    const adminMock = require('firebase-admin');
    adminMock.firestore.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: p10DocSetMock }),
      }),
      runTransaction: jest.fn().mockImplementation(async (callback: (tx: any) => Promise<void>) => {
        const fakeTx = {
          get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ bytes: 1_000_000 }) }),
          set: jest.fn(),
        };
        await callback(fakeTx);
      }),
    });
    adminMock.storage.mockReturnValue({
      bucket: jest.fn().mockReturnValue({
        file: p10BucketFileMock,
      }),
    });

    const cpMock = require('child_process');
    // 1st execSync call: probeInputVideo → HEVC input (forces needsTranscoding = true)
    // 2nd execSync call: verifyOutputFile → valid H.264/yuv420p output
    let execSyncCallCount = 0;
    cpMock.execSync = jest.fn().mockImplementation(() => {
      execSyncCallCount++;
      return execSyncCallCount === 1 ? 'hevc,yuv420p' : 'h264,yuv420p';
    });
    cpMock.spawn = jest.fn(() => {
      const EventEmitter = require('events');
      const proc = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    });

    const fsMock = require('fs');
    // 1st statSync: inputTmp → original file size (≥ 1)
    // 2nd statSync: outputTmp → H.264 output size (≥ 1024 for verification to pass)
    let statSyncCallCount = 0;
    fsMock.statSync = jest.fn().mockImplementation(() => {
      statSyncCallCount++;
      return statSyncCallCount === 1 ? { size: 4096 } : { size: 2048 };
    });
    fsMock.readFileSync.mockReturnValue(Buffer.alloc(2048, 0));
    fsMock.unlinkSync.mockImplementation(() => undefined);
  });

  /**
   * Wait until the Firestore doc has a 'done' status write (job fully complete).
   */
  function waitForDoneWrite(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const isDone = p10SetCalls.some((c) => c.data['status'] === 'done');
        if (isDone) return resolve();
        if (Date.now() > deadline) {
          return reject(
            new Error(
              `Timed out waiting for job 'done' write. Set calls so far: ${JSON.stringify(p10SetCalls)}`
            )
          );
        }
        setImmediate(poll);
      };
      setImmediate(poll);
    });
  }

  it(
    'bucket.file(originalPath).delete() is called and Firestore has originalDeleted:true for any valid TranscodeJob (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            originalPath: fc.string({ minLength: 1 }),
            bucketName: fc.string({ minLength: 1 }),
          }),
          async ({ originalPath, bucketName }) => {
            // Reset per-run state
            p10SetCalls.length = 0;
            p10DeletedPaths.length = 0;
            p10DocSetMock.mockClear();
            p10BucketFileMock.mockClear();

            // Re-wire mocks after clear so per-run references are fresh
            p10DocSetMock.mockImplementation((data: Record<string, unknown>, options?: unknown) => {
              p10SetCalls.push({ data, options });
              return Promise.resolve();
            });

            p10BucketFileMock.mockImplementation((filePath: string) => ({
              download: jest.fn().mockResolvedValue(undefined),
              save: jest.fn().mockResolvedValue(undefined),
              delete: jest.fn().mockImplementation(() => {
                p10DeletedPaths.push(filePath);
                return Promise.resolve();
              }),
            }));

            const adminMock = require('firebase-admin');
            adminMock.firestore.mockReturnValue({
              collection: jest.fn().mockReturnValue({
                doc: jest.fn().mockReturnValue({ set: p10DocSetMock }),
              }),
              runTransaction: jest.fn().mockImplementation(async (callback: (tx: any) => Promise<void>) => {
                const fakeTx = {
                  get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ bytes: 1_000_000 }) }),
                  set: jest.fn(),
                };
                await callback(fakeTx);
              }),
            });
            adminMock.storage.mockReturnValue({
              bucket: jest.fn().mockReturnValue({
                file: p10BucketFileMock,
              }),
            });

            // Reset execSync counter for this run
            const cpMock = require('child_process');
            let execSyncCallCount = 0;
            cpMock.execSync = jest.fn().mockImplementation(() => {
              execSyncCallCount++;
              return execSyncCallCount === 1 ? 'hevc,yuv420p' : 'h264,yuv420p';
            });
            cpMock.spawn = jest.fn(() => {
              const EventEmitter = require('events');
              const proc = new EventEmitter();
              (proc as any).stderr = new EventEmitter();
              process.nextTick(() => proc.emit('close', 0));
              return proc;
            });

            // Reset statSync counter for this run
            const fsMock = require('fs');
            let statSyncCallCount = 0;
            fsMock.statSync = jest.fn().mockImplementation(() => {
              statSyncCallCount++;
              return statSyncCallCount === 1 ? { size: 4096 } : { size: 2048 };
            });
            fsMock.readFileSync.mockReturnValue(Buffer.alloc(2048, 0));
            fsMock.unlinkSync.mockImplementation(() => undefined);

            const job = {
              originalPath,
              bucketName,
              originalUrl: 'https://example.com/videos/input.mov',
              contentType: 'video/quicktime',
              tenantId: 'test-tenant',
            };

            scheduleVideoTranscode(job);
            await waitForDoneWrite();

            // ── Assertion 1: bucket.file(originalPath).delete() was called ──────
            if (!p10DeletedPaths.includes(originalPath)) {
              throw new Error(
                `Expected bucket.file("${originalPath}").delete() to be called after successful transcode, ` +
                `but delete was only called for paths: [${p10DeletedPaths.map((p) => `"${p}"`).join(', ')}]`
              );
            }

            // ── Assertion 2: Firestore doc has originalDeleted: true ─────────────
            const originalDeletedWrite = p10SetCalls.find(
              (c) => c.data['originalDeleted'] === true
            );
            if (!originalDeletedWrite) {
              throw new Error(
                `Expected a Firestore set() with { originalDeleted: true } after successful transcode ` +
                `(originalPath="${originalPath}"). ` +
                `Set calls: ${JSON.stringify(p10SetCalls)}`
              );
            }

            return true;
          }
        ),
        { numRuns: 25, verbose: false }
      );
    },
    60_000
  );
});
