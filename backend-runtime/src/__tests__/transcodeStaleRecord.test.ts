/**
 * `runTranscodeJob`'s reuse/stale guard (upload-idempotency follow-up F21).
 *
 * Requirements: 5.4
 *
 * Asserted at the first observable fork rather than through a whole transcode: the
 * job either downloads the original (⇒ it decided to transcode) or it does not
 * (⇒ it deduped). `download` is wired to reject, so every case terminates in
 * milliseconds with no ffprobe, no ffmpeg and no timers — which also keeps this file
 * out of the hang the existing `videoTranscoder` suites fall into.
 *
 * Before F21 the "different bytes at the same deterministic path" case deduped like
 * every other, so the first test below fails against that code and the rest pass —
 * including the invariant test, which is the one that must never start failing.
 */

// ─── Self-contained firebase-admin harness ───────────────────────────────────
// Everything the mock needs is created INSIDE the factory and handed back on
// `__harness`, so nothing is read out of the enclosing scope while the module graph
// is still being required.

jest.mock('firebase-admin', () => {
  const setCalls: Array<{ data: Record<string, unknown>; options?: unknown }> = [];
  const state: { existingDoc: Record<string, unknown> | null } = { existingDoc: null };

  const set = jest.fn((data: Record<string, unknown>, options?: unknown) => {
    setCalls.push({ data, options });
    return Promise.resolve();
  });
  const get = jest.fn(() =>
    Promise.resolve({
      exists: state.existingDoc !== null,
      data: () => state.existingDoc,
    })
  );

  const download = jest.fn(() => Promise.reject(new Error('download stopped by test')));
  const save = jest.fn(() => Promise.resolve());
  const remove = jest.fn(() => Promise.resolve());

  return {
    __harness: { setCalls, state, set, get, download, save, remove },
    firestore: Object.assign(
      jest.fn(() => ({
        collection: jest.fn(() => ({ doc: jest.fn(() => ({ set, get })) })),
        runTransaction: jest.fn(() => Promise.resolve()),
      })),
      {
        FieldValue: {
          serverTimestamp: jest.fn(() => ({ _methodName: 'serverTimestamp' })),
          delete: jest.fn(() => ({ _methodName: 'delete' })),
        },
      }
    ),
    storage: jest.fn(() => ({
      bucket: jest.fn(() => ({
        name: 'test-bucket',
        file: jest.fn(() => ({ download, save, delete: remove })),
      })),
    })),
  };
});

import { runTranscodeJob, videoContentIdentity } from '../videoTranscoder';

const harness = (jest.requireMock('firebase-admin') as any).__harness as {
  setCalls: Array<{ data: Record<string, unknown>; options?: unknown }>;
  state: { existingDoc: Record<string, unknown> | null };
  set: jest.Mock;
  get: jest.Mock;
  download: jest.Mock;
};

const HASH_V1 = videoContentIdentity(Buffer.from('video-bytes-v1'));
const HASH_V2 = videoContentIdentity(Buffer.from('video-bytes-v2'));

const BASE_JOB = {
  originalPath: 'chat-files/tenant-a/c_conv/k_abc_video.mp4',
  bucketName: 'test-bucket',
  originalUrl: 'https://firebasestorage.googleapis.com/v0/b/test-bucket/o/x?alt=media&token=t1',
  contentType: 'video/mp4',
  tenantId: 'tenant-a',
};

/** A completed pre-F21 document, optionally carrying a content identity. */
function doneDoc(originalContentHash?: string): Record<string, unknown> {
  return {
    originalPath: BASE_JOB.originalPath,
    originalUrl: BASE_JOB.originalUrl,
    status: 'done',
    transcodedPath: 'chat-files/tenant-a/c_conv/k_abc_video_h264.mp4',
    transcodedUrl:
      'https://firebasestorage.googleapis.com/v0/b/test-bucket/o/y?alt=media&token=t2',
    originalDeleted: true,
    outputFileSizeBytes: 2_048,
    ...(originalContentHash ? { originalContentHash } : {}),
  };
}

/** Every field name written with a `FieldValue.delete()` sentinel. */
function clearedFields(): string[] {
  const cleared: string[] = [];
  for (const call of harness.setCalls) {
    for (const [key, value] of Object.entries(call.data)) {
      if ((value as any)?._methodName === 'delete') cleared.push(key);
    }
  }
  return cleared;
}

beforeEach(() => {
  harness.setCalls.length = 0;
  harness.state.existingDoc = null;
  harness.download.mockClear();
  harness.set.mockClear();
  harness.get.mockClear();
});

describe('runTranscodeJob — stale transcode record (different bytes at the same path)', () => {
  it('re-transcodes when the recorded content identity differs from the job\'s', async () => {
    harness.state.existingDoc = doneDoc(HASH_V1);

    await runTranscodeJob({ ...BASE_JOB, originalContentHash: HASH_V2 });

    expect(harness.download).toHaveBeenCalledTimes(1);
  });

  it('clears every field describing the previous video before re-transcoding', async () => {
    harness.state.existingDoc = doneDoc(HASH_V1);

    await runTranscodeJob({ ...BASE_JOB, originalContentHash: HASH_V2 });

    const cleared = clearedFields();
    // The two that keep serving the wrong video: ChatCacheService reads
    // `transcodedUrl` with no status filter, and `/video/request-transcode` returns
    // any `transcodedUrl` it finds regardless of status.
    expect(cleared).toContain('transcodedUrl');
    expect(cleared).toContain('transcodedPath');
    // And the ones that would otherwise misreport the new original's state.
    expect(cleared).toContain('originalDeleted');
    expect(cleared).toContain('outputFileSizeBytes');
  });

  it('records the new content identity on the processing write', async () => {
    harness.state.existingDoc = doneDoc(HASH_V1);

    await runTranscodeJob({ ...BASE_JOB, originalContentHash: HASH_V2 });

    const processingWrite = harness.setCalls.find((c) => c.data.status === 'processing');
    expect(processingWrite).toBeDefined();
    expect(processingWrite?.data.originalContentHash).toBe(HASH_V2);
  });
});

describe('runTranscodeJob — the dedupe invariant', () => {
  // THE invariant. A retry of one logical upload stores byte-identical content, so
  // the identities match and the transcode must NOT run again. Re-transcoding here
  // would undo the idempotency the upload-idempotency feature exists to provide
  // (design: "Data Flow: retry after a lost response").
  it('does NOT re-transcode a same-bytes retry', async () => {
    harness.state.existingDoc = doneDoc(HASH_V1);

    await runTranscodeJob({ ...BASE_JOB, originalContentHash: HASH_V1 });

    expect(harness.download).not.toHaveBeenCalled();
  });

  it('repairs the status to done on a same-bytes retry, clearing nothing else', async () => {
    harness.state.existingDoc = doneDoc(HASH_V1);

    await runTranscodeJob({ ...BASE_JOB, originalContentHash: HASH_V1 });

    const doneWrite = harness.setCalls.find((c) => c.data.status === 'done');
    expect(doneWrite).toBeDefined();
    expect(clearedFields()).toEqual(expect.arrayContaining(['error', 'failedAt']));
    expect(clearedFields()).not.toContain('transcodedUrl');
  });
});

describe('runTranscodeJob — migration posture (no recorded content identity)', () => {
  // Pre-F21 documents carry no identity. Guessing "changed" would retroactively
  // re-transcode every existing video the first time it was touched.
  it('does NOT re-transcode when the existing document carries no content identity', async () => {
    harness.state.existingDoc = doneDoc(undefined);

    await runTranscodeJob({ ...BASE_JOB, originalContentHash: HASH_V2 });

    expect(harness.download).not.toHaveBeenCalled();
  });

  // `POST /video/request-transcode` holds no bytes (and the original may already be
  // deleted), so it supplies no identity. Its idempotency must be unchanged.
  it('does NOT re-transcode when the job carries no content identity', async () => {
    harness.state.existingDoc = doneDoc(HASH_V1);

    await runTranscodeJob({ ...BASE_JOB });

    expect(harness.download).not.toHaveBeenCalled();
  });

  it('leaves an already-recorded identity intact when a job supplies none', async () => {
    harness.state.existingDoc = { ...doneDoc(HASH_V1), transcodedUrl: '' };

    await runTranscodeJob({ ...BASE_JOB });

    const processingWrite = harness.setCalls.find((c) => c.data.status === 'processing');
    expect(processingWrite).toBeDefined();
    expect('originalContentHash' in (processingWrite?.data ?? {})).toBe(false);
    expect(processingWrite?.options).toEqual({ merge: true });
  });
});

describe('runTranscodeJob — documents with no recorded output are unaffected', () => {
  it('transcodes when no document exists', async () => {
    harness.state.existingDoc = null;

    await runTranscodeJob({ ...BASE_JOB, originalContentHash: HASH_V1 });

    expect(harness.download).toHaveBeenCalledTimes(1);
  });

  it('transcodes when a previous attempt errored without producing an output', async () => {
    harness.state.existingDoc = {
      originalPath: BASE_JOB.originalPath,
      status: 'error',
      error: 'probe_failed',
      originalContentHash: HASH_V1,
    };

    await runTranscodeJob({ ...BASE_JOB, originalContentHash: HASH_V1 });

    expect(harness.download).toHaveBeenCalledTimes(1);
  });
});
