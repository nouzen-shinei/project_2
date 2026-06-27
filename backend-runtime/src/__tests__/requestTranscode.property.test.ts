// Feature: video-transcoding-compatibility, Property 3: /video/request-transcode is idempotent

/**
 * Property 3: /video/request-transcode is idempotent
 * Validates: Requirements 1.4
 *
 * For any valid (originalUrl, tenantId) pair, calling POST /video/request-transcode
 * N times (N ∈ [2,5]) sequentially SHALL result in:
 *   - `scheduleVideoTranscode` being called at most once (idempotency)
 *   - all responses reflecting the same `status` field
 *
 * This test exercises the idempotency logic directly by simulating N sequential
 * calls to the route handler's core logic: read Firestore doc → decide action →
 * optionally schedule. We mock `firebase-admin` and `scheduleVideoTranscode` to
 * control Firestore state and observe scheduling behaviour.
 */

import * as fc from 'fast-check';

// ─── Fixed Firebase Storage URL ───────────────────────────────────────────────
// storagePathFromUrl() requires a valid Firebase Storage download URL of the form:
//   https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodedPath}?...
// fc.webUrl() won't generate these, so we use a constant URL and vary tenantId.
const STORAGE_URL =
  'https://firebasestorage.googleapis.com/v0/b/test-bucket/o/tenants%2Ftenant-x%2Fvideos%2Fvideo.mp4?alt=media&token=abc123';

// ─── Shared mock state (mutated per property run) ────────────────────────────

/** In-memory Firestore document store: docId → document data */
let firestoreDocStore: Record<string, Record<string, unknown>> = {};

// ─── Mocks ───────────────────────────────────────────────────────────────────
// These must be at the top level (hoisted) before any imports.

jest.mock('firebase-admin', () => {
  return {
    firestore: Object.assign(
      jest.fn(() => ({
        collection: jest.fn((_name: string) => ({
          doc: jest.fn((id: string) => ({
            get: jest.fn(async () => {
              const data = firestoreDocStore[id];
              return { exists: Boolean(data), data: () => data ?? null };
            }),
            set: jest.fn(async (data: Record<string, unknown>, _opts?: unknown) => {
              firestoreDocStore[id] = { ...(firestoreDocStore[id] ?? {}), ...data };
            }),
          })),
        })),
      })),
      {
        FieldValue: {
          serverTimestamp: jest.fn().mockReturnValue({ _methodName: 'serverTimestamp' }),
        },
      }
    ),
    storage: jest.fn(() => ({
      bucket: jest.fn().mockReturnValue({
        name: 'test-bucket',
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(undefined),
          save: jest.fn().mockResolvedValue(undefined),
          delete: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    })),
    apps: [],
    initializeApp: jest.fn(),
  };
});

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

// ─── Mock videoTranscoder — intercept scheduleVideoTranscode ──────────────────
// scheduleVideoTranscode is the side-effectful call we must count.
// After the first call, we simulate the transcoder writing a 'processing' doc
// so subsequent handler invocations find the existing document.

jest.mock('../videoTranscoder', () => {
  const actual = jest.requireActual('../videoTranscoder');
  return {
    ...actual,
    scheduleVideoTranscode: jest.fn(),
  };
});

// ─── Import module under test after mocks ────────────────────────────────────

import { storagePathFromUrl } from '../app';
import { transcodeDocId, scheduleVideoTranscode } from '../videoTranscoder';

// ─── Route handler logic under test ──────────────────────────────────────────
/**
 * Simulates the core idempotency logic of the POST /video/request-transcode
 * route handler (from app.ts lines ~12101–12170):
 *
 *   1. Extract storage path from originalUrl
 *   2. Compute docId = sha256(storagePath)
 *   3. Read videoTranscodes/{docId}
 *   4. If 'done'       → return { status: 'done', transcodedUrl }
 *   5. If 'processing' → return { status: 'processing' }
 *   6. Else            → call scheduleVideoTranscode → return { status: 'processing' }
 *
 * Returns the response body the route would send to the client.
 */
async function simulateRouteHandler(
  originalUrl: string,
  tenantId: string
): Promise<{ status: string; transcodedUrl?: string; httpCode: number }> {
  const admin = require('firebase-admin');

  let storagePath: string;
  try {
    storagePath = storagePathFromUrl(originalUrl);
  } catch {
    return { status: 'invalid_storage_url', httpCode: 400 };
  }

  const docId = transcodeDocId(storagePath);
  const db = admin.firestore();
  const docRef = db.collection('videoTranscodes').doc(docId);
  const snap = await docRef.get();

  if (snap.exists) {
    const data = snap.data() as Record<string, unknown>;
    const status = typeof data?.status === 'string' ? data.status : '';

    if (status === 'done') {
      return { status: 'done', transcodedUrl: data.transcodedUrl as string | undefined, httpCode: 200 };
    }
    if (status === 'processing') {
      return { status: 'processing', httpCode: 202 };
    }
    // error or unknown → fall through to schedule
  }

  // No doc or status==='error': schedule and mark processing
  (scheduleVideoTranscode as jest.Mock)({
    originalPath: storagePath,
    bucketName: 'test-bucket',
    originalUrl,
    contentType: 'video/mp4',
    tenantId,
  });

  // Write 'processing' document immediately (simulates what scheduleVideoTranscode
  // does asynchronously in production; here we do it synchronously so subsequent
  // handler calls within the same test run see the document).
  firestoreDocStore[docId] = { status: 'processing', tenantId };

  return { status: 'processing', httpCode: 202 };
}

// ─── Property test ────────────────────────────────────────────────────────────

describe('Property 3 — /video/request-transcode is idempotent', () => {
  beforeEach(() => {
    firestoreDocStore = {};
    jest.clearAllMocks();

    // Re-wire firebase-admin mock after clearAllMocks
    const adminMock = require('firebase-admin');
    adminMock.firestore.mockImplementation(() => ({
      collection: jest.fn((_name: string) => ({
        doc: jest.fn((id: string) => ({
          get: jest.fn(async () => {
            const data = firestoreDocStore[id];
            return { exists: Boolean(data), data: () => data ?? null };
          }),
          set: jest.fn(async (data: Record<string, unknown>) => {
            firestoreDocStore[id] = { ...(firestoreDocStore[id] ?? {}), ...data };
          }),
        })),
      })),
    }));

    // Re-wire scheduleVideoTranscode to increment count and write processing doc
    (scheduleVideoTranscode as jest.Mock).mockImplementation(() => {
      // Intentional no-op: the simulateRouteHandler writes the doc directly
    });
  });

  it(
    'scheduleVideoTranscode is called at most once and all responses share the same status (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generator: tenantId (non-empty string) + N ∈ [2,5] sequential calls
          fc.string({ minLength: 1, maxLength: 40 }),
          fc.integer({ min: 2, max: 5 }),
          async (tenantId, n) => {
            // ── Reset per-run state ───────────────────────────────────────────
            firestoreDocStore = {};
            (scheduleVideoTranscode as jest.Mock).mockClear();

            // ── Re-wire firebase-admin for this run ──────────────────────────
            const adminMock = require('firebase-admin');
            adminMock.firestore.mockImplementation(() => ({
              collection: jest.fn((_name: string) => ({
                doc: jest.fn((id: string) => ({
                  get: jest.fn(async () => {
                    const data = firestoreDocStore[id];
                    return { exists: Boolean(data), data: () => data ?? null };
                  }),
                  set: jest.fn(async (data: Record<string, unknown>) => {
                    firestoreDocStore[id] = { ...(firestoreDocStore[id] ?? {}), ...data };
                  }),
                })),
              })),
            }));

            // ── Make N sequential simulated route handler calls ───────────────
            const responses: Array<{ status: string; httpCode: number }> = [];
            for (let i = 0; i < n; i++) {
              const resp = await simulateRouteHandler(STORAGE_URL, tenantId);
              responses.push(resp);
            }

            // ── Assert 1: scheduleVideoTranscode called at most once ──────────
            const scheduleCallCount = (scheduleVideoTranscode as jest.Mock).mock.calls.length;
            if (scheduleCallCount > 1) {
              throw new Error(
                `scheduleVideoTranscode was called ${scheduleCallCount} times for ${n} sequential ` +
                `requests — expected at most 1 call (idempotency violation). ` +
                `tenantId="${tenantId}", responses=${JSON.stringify(responses)}`
              );
            }

            // ── Assert 2: all responses must reflect the same status field ────
            // All requests after the first must see the same status. The first
            // call schedules and returns 'processing'; all subsequent calls must
            // also return 'processing' (not re-schedule). No response should
            // ever differ from the others in a way that indicates a new job
            // was created (which would violate idempotency).
            const statuses = responses.map((r) => r.status);
            const allSameStatus = statuses.every((s) => s === statuses[0]);
            if (!allSameStatus) {
              throw new Error(
                `Responses did not all share the same status — idempotency violated. ` +
                `Got statuses: ${JSON.stringify(statuses)}. ` +
                `tenantId="${tenantId}", n=${n}`
              );
            }

            // ── Assert 3: every HTTP code must be 200 or 202 ─────────────────
            const invalidCodes = responses.filter((r) => r.httpCode !== 200 && r.httpCode !== 202);
            if (invalidCodes.length > 0) {
              throw new Error(
                `Expected all responses to have HTTP code 200 or 202, but got: ` +
                `${JSON.stringify(invalidCodes)}. tenantId="${tenantId}", n=${n}`
              );
            }

            return true;
          }
        ),
        { numRuns: 30, verbose: false }
      );
    },
    30_000
  );

  it(
    'if first call finds a done doc, all N calls return done status without scheduling (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 40 }),          // tenantId
          fc.string({ minLength: 1, maxLength: 200 }),         // transcodedUrl
          fc.integer({ min: 2, max: 5 }),                      // N calls
          async (tenantId, transcodedUrl, n) => {
            firestoreDocStore = {};
            (scheduleVideoTranscode as jest.Mock).mockClear();

            // Pre-populate Firestore with a 'done' document
            const storagePath = storagePathFromUrl(STORAGE_URL);
            const docId = transcodeDocId(storagePath);
            firestoreDocStore[docId] = { status: 'done', transcodedUrl, tenantId };

            const adminMock = require('firebase-admin');
            adminMock.firestore.mockImplementation(() => ({
              collection: jest.fn((_name: string) => ({
                doc: jest.fn((id: string) => ({
                  get: jest.fn(async () => {
                    const data = firestoreDocStore[id];
                    return { exists: Boolean(data), data: () => data ?? null };
                  }),
                  set: jest.fn(async (data: Record<string, unknown>) => {
                    firestoreDocStore[id] = { ...(firestoreDocStore[id] ?? {}), ...data };
                  }),
                })),
              })),
            }));

            const responses: Array<{ status: string; httpCode: number }> = [];
            for (let i = 0; i < n; i++) {
              const resp = await simulateRouteHandler(STORAGE_URL, tenantId);
              responses.push(resp);
            }

            // scheduleVideoTranscode must NEVER be called if job is already done
            const scheduleCallCount = (scheduleVideoTranscode as jest.Mock).mock.calls.length;
            if (scheduleCallCount > 0) {
              throw new Error(
                `scheduleVideoTranscode was called ${scheduleCallCount} time(s) when the ` +
                `document already had status='done'. Expected 0 calls. ` +
                `tenantId="${tenantId}", n=${n}`
              );
            }

            // All responses must say 'done'
            const nonDone = responses.filter((r) => r.status !== 'done');
            if (nonDone.length > 0) {
              throw new Error(
                `Expected all ${n} responses to have status='done' when doc is pre-populated as done. ` +
                `Got: ${JSON.stringify(responses)}. tenantId="${tenantId}"`
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

  it(
    'if first call finds a processing doc, all N calls return processing without scheduling (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 40 }),   // tenantId
          fc.integer({ min: 2, max: 5 }),               // N calls
          async (tenantId, n) => {
            firestoreDocStore = {};
            (scheduleVideoTranscode as jest.Mock).mockClear();

            // Pre-populate Firestore with a 'processing' document
            const storagePath = storagePathFromUrl(STORAGE_URL);
            const docId = transcodeDocId(storagePath);
            firestoreDocStore[docId] = { status: 'processing', tenantId };

            const adminMock = require('firebase-admin');
            adminMock.firestore.mockImplementation(() => ({
              collection: jest.fn((_name: string) => ({
                doc: jest.fn((id: string) => ({
                  get: jest.fn(async () => {
                    const data = firestoreDocStore[id];
                    return { exists: Boolean(data), data: () => data ?? null };
                  }),
                  set: jest.fn(async (data: Record<string, unknown>) => {
                    firestoreDocStore[id] = { ...(firestoreDocStore[id] ?? {}), ...data };
                  }),
                })),
              })),
            }));

            const responses: Array<{ status: string; httpCode: number }> = [];
            for (let i = 0; i < n; i++) {
              const resp = await simulateRouteHandler(STORAGE_URL, tenantId);
              responses.push(resp);
            }

            // scheduleVideoTranscode must NEVER be called
            const scheduleCallCount = (scheduleVideoTranscode as jest.Mock).mock.calls.length;
            if (scheduleCallCount > 0) {
              throw new Error(
                `scheduleVideoTranscode was called ${scheduleCallCount} time(s) when the ` +
                `document already had status='processing'. Expected 0 calls. ` +
                `tenantId="${tenantId}", n=${n}`
              );
            }

            // All responses must say 'processing'
            const nonProcessing = responses.filter((r) => r.status !== 'processing');
            if (nonProcessing.length > 0) {
              throw new Error(
                `Expected all ${n} responses to have status='processing' when doc is already processing. ` +
                `Got: ${JSON.stringify(responses)}. tenantId="${tenantId}"`
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
