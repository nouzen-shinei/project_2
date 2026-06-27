/**
 * Unit tests for `runTranscodeJob` deletion failure paths
 *
 * Task 7.13 — Requirements 3.4, 3.5
 *
 * Test 1: Deletion fails twice → job status is `done`, Firestore doc has
 *   `originalDeleteError: true` and `originalDeleteErrorMessage` set.
 *
 * Test 2: `needsTranscoding` returns false (h264/yuv420p source) → no
 *   Storage delete is called, no quota transaction is called, and the job
 *   status is `skipped`.
 */

// ─── Mock declarations (must be before any imports) ─────────────────────────

/** All arguments passed to doc.set(), in call order. */
const unitSetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];

const unitDocSetMock = jest.fn((data: Record<string, unknown>, options?: unknown) => {
  unitSetCalls.push({ data, options });
  return Promise.resolve();
});

const unitRunTransactionMock = jest.fn().mockImplementation(
  async (callback: (tx: unknown) => Promise<void>) => {
    const fakeTx = {
      get: jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({ bytes: 1_000_000 }),
      }),
      set: jest.fn(),
    };
    await callback(fakeTx);
  }
);

const unitFileMock = jest.fn();

jest.mock('firebase-admin', () => ({
  firestore: Object.assign(
    jest.fn(() => ({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: unitDocSetMock }),
      }),
      runTransaction: unitRunTransactionMock,
    })),
    {
      FieldValue: {
        serverTimestamp: jest.fn().mockReturnValue({ _methodName: 'serverTimestamp' }),
      },
    }
  ),
  storage: jest.fn(() => ({
    bucket: jest.fn().mockReturnValue({
      file: unitFileMock,
    }),
  })),
}));

jest.mock('child_process', () => ({
  execSync: jest.fn().mockReturnValue('hevc,yuv420p10le'),
  spawn: jest.fn(() => {
    const EventEmitter = require('events');
    const proc = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    process.nextTick(() => proc.emit('close', 0));
    return proc;
  }),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn().mockReturnValue(Buffer.alloc(2048, 0)),
  statSync: jest.fn().mockReturnValue({ size: 4096 }),
  unlinkSync: jest.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

import { scheduleVideoTranscode } from '../videoTranscoder';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wait until at least one Firestore set() call contains the given `status`,
 * or until the timeout is exceeded.
 */
function waitForStatus(
  status: string,
  calls: Array<{ data: Record<string, unknown> }>,
  timeoutMs = 8_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (calls.some((c) => c.data['status'] === status)) return resolve();
      if (Date.now() > deadline) {
        return reject(
          new Error(
            `Timed out waiting for Firestore status="${status}". ` +
              `Calls so far: ${JSON.stringify(calls)}`
          )
        );
      }
      setImmediate(poll);
    };
    setImmediate(poll);
  });
}

/**
 * Wait until any Firestore set() call contains the given key, or timeout.
 */
function waitForKey(
  key: string,
  calls: Array<{ data: Record<string, unknown> }>,
  timeoutMs = 8_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (calls.some((c) => key in c.data)) return resolve();
      if (Date.now() > deadline) {
        return reject(
          new Error(
            `Timed out waiting for Firestore key="${key}". ` +
              `Calls so far: ${JSON.stringify(calls)}`
          )
        );
      }
      setImmediate(poll);
    };
    setImmediate(poll);
  });
}

// ─── Shared job fixture ───────────────────────────────────────────────────────

const BASE_JOB = {
  originalPath: 'tenants/test-tenant/videos/original.mov',
  bucketName: 'test-bucket',
  originalUrl: 'https://example.com/videos/original.mov',
  contentType: 'video/quicktime',
  tenantId: 'test-tenant',
};

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Deletion fails twice → status `done`, `originalDeleteError: true`
//
// Requirement 3.4: If the retry also fails, the Transcoder SHALL record
// `originalDeleteError: true` and `originalDeleteErrorMessage` in the
// `videoTranscodes` document and the job SHALL be marked `done` (not `error`).
// ─────────────────────────────────────────────────────────────────────────────

describe('runTranscodeJob — deletion fails twice', () => {
  // Capture set calls scoped to this suite
  const localSetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];

  beforeEach(() => {
    localSetCalls.length = 0;
    jest.clearAllMocks();
    jest.useRealTimers();

    // Doc mock scoped to this suite
    unitDocSetMock.mockImplementation((data: Record<string, unknown>, options?: unknown) => {
      localSetCalls.push({ data, options });
      return Promise.resolve();
    });

    // Re-wire firebase-admin to use the local doc mock
    const adminMock = require('firebase-admin');
    adminMock.firestore.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: unitDocSetMock }),
      }),
      runTransaction: unitRunTransactionMock,
    });
    adminMock.storage.mockReturnValue({
      bucket: jest.fn().mockReturnValue({
        file: unitFileMock,
      }),
    });

    // execSync: 1st = probeInputVideo (HEVC → needsTranscoding true)
    //           2nd = verifyOutputFile (valid H.264 output)
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

    // fs: statSync returns ≥1024 bytes for outputTmp so size check passes
    const fsMock = require('fs');
    let statSyncCallCount = 0;
    fsMock.statSync = jest.fn().mockImplementation(() => {
      statSyncCallCount++;
      return statSyncCallCount === 1 ? { size: 4_096 } : { size: 2_048 };
    });
    fsMock.readFileSync = jest.fn().mockReturnValue(Buffer.alloc(2_048, 0));
    fsMock.unlinkSync = jest.fn();

    // quota runTransaction succeeds (we only care about deletion behaviour)
    unitRunTransactionMock.mockImplementation(
      async (callback: (tx: unknown) => Promise<void>) => {
        const fakeTx = {
          get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ bytes: 1_000_000 }) }),
          set: jest.fn(),
        };
        await callback(fakeTx);
      }
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it(
    'marks the job done (not error) and sets originalDeleteError:true when both deletion attempts fail',
    async () => {
      // bucket.file() returns an object whose delete() always rejects.
      // We do NOT use fake timers here — instead we rely on the real 5-second
      // timeout inside deleteOriginalWithRetry, but we shorten it by replacing
      // setTimeout at the global level so sleep() resolves in 0ms.
      const originalSetTimeout = global.setTimeout;
      // @ts-ignore — override setTimeout to fire immediately (0ms) so the
      // 5-second sleep in deleteOriginalWithRetry completes without real delay.
      global.setTimeout = (fn: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
        return originalSetTimeout(fn, 0, ...args);
      };

      try {
        const deleteError = new Error('Storage delete failed: permission denied');
        unitFileMock.mockImplementation(() => ({
          download: jest.fn().mockResolvedValue(undefined),
          save: jest.fn().mockResolvedValue(undefined),
          delete: jest.fn().mockRejectedValue(deleteError),
        }));

        // Schedule the job
        scheduleVideoTranscode(BASE_JOB);

        // Wait until originalDeleteError key is written to Firestore.
        // Since we zeroed the sleep delay, the retry should complete quickly.
        await waitForKey('originalDeleteError', localSetCalls, 10_000);

        // ── Assertion 1: job is marked `done`, not `error` ─────────────────
        // The `done` status is written after deleteOriginalWithRetry returns.
        // Poll briefly for the done write.
        await waitForStatus('done', localSetCalls, 5_000);

        const doneWrite = localSetCalls.find((c) => c.data['status'] === 'done');
        expect(doneWrite).toBeDefined();
        const errorStatusWrite = localSetCalls.find((c) => c.data['status'] === 'error');
        expect(errorStatusWrite).toBeUndefined();

        // ── Assertion 2: `originalDeleteError: true` is written ────────────
        const deleteErrorWrite = localSetCalls.find((c) => c.data['originalDeleteError'] === true);
        expect(deleteErrorWrite).toBeDefined();

        // ── Assertion 3: `originalDeleteErrorMessage` is a non-empty string ──
        expect(typeof deleteErrorWrite?.data['originalDeleteErrorMessage']).toBe('string');
        expect(
          (deleteErrorWrite?.data['originalDeleteErrorMessage'] as string).length
        ).toBeGreaterThan(0);
      } finally {
        // Always restore the original setTimeout
        global.setTimeout = originalSetTimeout;
      }
    },
    20_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: `needsTranscoding` returns false → no Storage delete, no quota change
//
// Requirement 3.5: When the Transcoder determines that a video does not need
// transcoding (status `skipped`), the Transcoder SHALL NOT delete the original
// file and SHALL leave the `tenantStorageUsage` record unchanged.
// ─────────────────────────────────────────────────────────────────────────────

describe('runTranscodeJob — needsTranscoding returns false', () => {
  const localSetCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];
  let localDeleteMock: jest.Mock;
  let localRunTransactionMock: jest.Mock;

  beforeEach(() => {
    localSetCalls.length = 0;
    jest.clearAllMocks();
    jest.useRealTimers();

    localDeleteMock = jest.fn().mockResolvedValue(undefined);
    localRunTransactionMock = jest.fn().mockResolvedValue(undefined);

    const localDocSetMock = jest.fn((data: Record<string, unknown>, options?: unknown) => {
      localSetCalls.push({ data, options });
      return Promise.resolve();
    });

    // Re-wire firebase-admin with scoped mocks
    const adminMock = require('firebase-admin');
    adminMock.firestore.mockReturnValue({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: localDocSetMock }),
      }),
      runTransaction: localRunTransactionMock,
    });
    adminMock.storage.mockReturnValue({
      bucket: jest.fn().mockReturnValue({
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(undefined),
          save: jest.fn().mockResolvedValue(undefined),
          delete: localDeleteMock,
        }),
      }),
    });

    // execSync returns 'h264,yuv420p' → codec='h264', bitDepth=8
    // With contentType 'video/mp4', needsTranscoding() returns false
    const cpMock = require('child_process');
    cpMock.execSync = jest.fn().mockReturnValue('h264,yuv420p');
    cpMock.spawn = jest.fn(() => {
      const EventEmitter = require('events');
      const proc = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    });

    const fsMock = require('fs');
    fsMock.statSync = jest.fn().mockReturnValue({ size: 4_096 });
    fsMock.readFileSync = jest.fn().mockReturnValue(Buffer.alloc(2_048, 0));
    fsMock.unlinkSync = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it(
    'does not call bucket.file().delete() when the video is already H.264 compatible',
    async () => {
      const job = {
        ...BASE_JOB,
        // mp4 + h264 + yuv420p → needsTranscoding returns false
        contentType: 'video/mp4',
      };

      scheduleVideoTranscode(job);
      await waitForStatus('skipped', localSetCalls);

      expect(localDeleteMock).not.toHaveBeenCalled();
    },
    10_000
  );

  it(
    'does not call db.runTransaction (no quota changes) when the video is already H.264 compatible',
    async () => {
      const job = {
        ...BASE_JOB,
        contentType: 'video/mp4',
      };

      scheduleVideoTranscode(job);
      await waitForStatus('skipped', localSetCalls);

      expect(localRunTransactionMock).not.toHaveBeenCalled();
    },
    10_000
  );

  it(
    'sets the Firestore document status to skipped when needsTranscoding is false',
    async () => {
      const job = {
        ...BASE_JOB,
        contentType: 'video/mp4',
      };

      scheduleVideoTranscode(job);
      await waitForStatus('skipped', localSetCalls);

      const skippedWrite = localSetCalls.find((c) => c.data['status'] === 'skipped');
      expect(skippedWrite).toBeDefined();
    },
    10_000
  );
});
