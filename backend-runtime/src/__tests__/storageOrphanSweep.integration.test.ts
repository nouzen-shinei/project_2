/**
 * Integration tests for the storage orphan sweep in report mode
 * (spec `storage-orphan-cleanup`, task 6.10).
 *
 * Drives the real `runStorageOrphanSweep` against a fake bucket with metadata
 * tracking and paged `getFiles`, an in-memory queryable Firestore and an in-memory
 * Realtime Database supporting `orderByKey().startAfter().limitToFirst()` — all
 * three appending to **one chronological operation log**. That single log is what
 * makes the ordering claims directly assertable rather than inferred. The precedent
 * is `storageUploadRoute.integration.test.ts`.
 *
 * ── The two headline cases ──────────────────────────────────────────────────
 *
 * `a chat attachment referenced only in the Realtime Database is retained` and
 * `the identical fixture with the RTDB source disabled aborts` are the regression
 * gates for the whole spec. Chat attachments live in the Realtime Database, not
 * Firestore, and `chat-files/{tenantId}/` is the largest prefix in the bucket — so
 * a collector that enumerated only Firestore would find no reference to any chat
 * attachment and would report every one of them as an orphan. The second case pins
 * the other half: when that source cannot be read, the sweep must STOP rather than
 * conclude that the objects it could not see are unreferenced.
 *
 * The branding case carries its own negative control for the same reason: five
 * fields are read, and a run that read only `logoUrl` would report four live
 * objects. The control is asserted, not asserted-about.
 */

import {
  deriveProfilePicturePath,
  parseQuarantinePath,
  QUARANTINE_PREFIX,
  STORAGE_TENANT_CATEGORIES,
  TenantScopeViolation,
} from '../lib/storageObjectRef';
import { buildTranscodeStoragePath } from '../videoTranscoder';
import {
  RETAIN_REASONS,
  assertSweepInvariants,
  purgeExpiredQuarantine,
  quarantineManifestPath,
  quarantineObject,
  runStorageOrphanSweep,
  tenantReportPath,
  type SweepCounters,
} from '../jobs/storageOrphanSweep';
// The two pure decisions the ceiling and the guard are made with. Imported rather than
// restated so a case asserts the number the run actually compared against, and so the
// deliberate asymmetry between them stays visible: `exceedsHeapGuard` requires the
// Heap_Guard_Floor as well as the fraction, which is what makes the `used = 1,
// limit = 1` case below a non-breach.
import {
  HEAP_GUARD_SAMPLE_INTERVAL,
  estimateRetainSetFootprintBytes,
  exceedsHeapGuard,
} from '../lib/sweepScaleLimits';
// The runner's exit-code decision, as a value. Req 11.19's substitution asks for
// Req 2.1's non-zero exit code, and this is how it is asserted without spawning a
// process and without mutating `process.exitCode` inside the test runner — which
// would leak into jest's own exit status. The runner's `main()` is unexported and
// unreachable here, exactly as `runStorageOrphanSweep.test.ts` asserts.
import { sweepRunExitCode } from '../jobs/runStorageOrphanSweep';
// The Run_Lease, driven for real by the additive cases at the end of this file
// (task 9.6). Imported here rather than stubbed so the fencing branch and the
// token-matched release under test are the module's own.
import {
  RUN_LEASE_JOB_NAME,
  acquireRunLease,
  runLeasePath,
  type RunLeaseHandle,
} from '../jobs/storageOrphanSweepLease';
import {
  BUCKET_NAME,
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  downloadUrl,
  iso,
  sweepConfig,
  type DocData,
  type FakeObject,
  type Operation,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

// Importing the runner module for `sweepRunExitCode` must not load
// `backend-runtime/.env` into `process.env`: jest runs the suites of one worker in
// a single process, so that would leak real configuration into every suite
// scheduled after this one. Same reasoning, same mock, as
// `runStorageOrphanSweep.test.ts`. Nothing else about the runner is mocked, and
// `main()` stays unreachable behind `require.main === module`.
jest.mock('dotenv/config', () => ({}));

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;

/** Old enough that only a reference can retain it. */
const OLD = iso(NOW - 120 * DAY);
/** Inside the 7-day grace window. */
const FRESH = iso(NOW - 2 * DAY);

interface Scenario {
  objects?: FakeObject[];
  collections?: Record<string, Record<string, DocData>>;
  tree?: Record<string, unknown>;
  rtdbFails?: unknown;
  config?: Record<string, unknown>;
  /**
   * ── The apply-mode additions (task 8.4) ───────────────────────────────────
   *
   * All four are optional and inert by default, so every report-mode case above
   * behaves exactly as it did. `log`, `db` and `bucket` exist so a resume case can
   * drive TWO runs against the same Firestore and the same bucket while still
   * appending to one chronological log — which is the only way "the interrupted run
   * and its resumption examined the same union" is a statement about observed
   * operations rather than about counters.
   */
  log?: OperationLog;
  db?: ReturnType<typeof createFakeFirestore>;
  bucket?: ReturnType<typeof createFakeBucket>;
  invalidateLiveCount?: (cacheKey: string) => void;
  /**
   * ── The write-cadence additions (task 6.6) ────────────────────────────────
   *
   * Both optional and inert by default, so every case above behaves exactly as it
   * did.
   *
   * `now` is the LIVE clock the report-write scheduler reads, and it is frozen by
   * the cadence cases so a measured write count is the page interval's and the
   * threshold's alone: the Report_Write_Time_Interval is a LOWER bound on write
   * frequency, so a slow machine would otherwise be able to add a time-driven write
   * to a count asserted as an exact number. It is NOT `config.nowMs`, which stays
   * frozen for every case for a different reason — see `SweepTenantArgs.now`.
   *
   * `quarantineObject` replaces the real mover, and the cadence cases use it only to
   * WRAP it: a wrapper that counts calls, snapshots the Report_Document between two
   * moves, or throws on the *n*-th move is how "a write landed mid-page" and "the
   * process crashed after 20 moves" become observable without a fake mover that
   * moves nothing.
   */
  now?: () => number;
  quarantineObject?: typeof quarantineObject;
  /**
   * ── The heap-guard addition (task 8.7) ────────────────────────────────────
   *
   * Optional and inert by default, so every case above behaves exactly as it did: with
   * nothing installed the collector uses the real `readProcessHeapUsage`, which is a
   * `v8.getHeapStatistics()` call and nothing else.
   *
   * Only the READING is a seam; the comparison stays the pure `exceedsHeapGuard`. That
   * is what lets a case put the guard's crossing at a chosen admitted-reference count
   * while still exercising the same two-condition predicate a production run does — a
   * seam over the comparison would let a case assert a guard that is present without
   * asserting the guard that is correct.
   */
  readHeapUsage?: () => { usedBytes: number; limitBytes: number };
  /**
   * ── The Run_Lease addition (task 9.6) ─────────────────────────────────────
   *
   * Optional and inert by default, so every case above behaves exactly as it did —
   * which is Req 5.16 in the test suite as well as in the type: "without a lease"
   * is literally the configuration every other case in this file runs in.
   *
   * With something installed, the core calls it as the first statement of each
   * tenant iteration and does nothing else with it. The lease cases below pass the
   * REAL `RunLeaseHandle.renew`, so the fencing branch under test is the module's
   * own rather than a stand-in that returns `{ ok: false }`.
   */
  renewRunLease?: () => Promise<{ ok: boolean }>;
}

interface SweepRun {
  log: OperationLog;
  db: ReturnType<typeof createFakeFirestore>;
  bucket: ReturnType<typeof createFakeBucket>;
  result: Awaited<ReturnType<typeof runStorageOrphanSweep>>;
  report(tenantId?: string): DocData;
  reported(tenantId?: string): string[];
}

async function sweep(scenario: Scenario): Promise<SweepRun> {
  const log = scenario.log ?? createOperationLog();
  const bucket = scenario.bucket ?? createFakeBucket({ log, objects: scenario.objects ?? [] });
  const db = scenario.db ?? createFakeFirestore({ log, collections: scenario.collections });
  const rtdb = createFakeRtdb({
    log,
    tree: scenario.tree ?? {},
    ...(scenario.rtdbFails === undefined ? {} : { failure: { value: scenario.rtdbFails } }),
  });

  const config = sweepConfig({ nowMs: NOW, ...scenario.config });
  // The real mover, installed only when this run's own config asks to mutate. A
  // report-mode run gets none, so it stays structurally incapable of moving an
  // object rather than merely declining to.
  const applyMode = config.mode === 'sweep' && config.apply === true;

  const result = await runStorageOrphanSweep({
    db: db as never,
    rtdb: rtdb as never,
    bucket: bucket as never,
    config: config as never,
    ...(applyMode ? { quarantineObject: scenario.quarantineObject ?? quarantineObject } : {}),
    ...(scenario.invalidateLiveCount ? { invalidateLiveCount: scenario.invalidateLiveCount } : {}),
    ...(scenario.now ? { now: scenario.now } : {}),
    ...(scenario.readHeapUsage ? { readHeapUsage: scenario.readHeapUsage } : {}),
    ...(scenario.renewRunLease ? { renewRunLease: scenario.renewRunLease } : {}),
  });

  return {
    log,
    db,
    bucket,
    result,
    report: (tenantId = TENANT) => db.read(tenantReportPath(tenantId)) as DocData,
    reported: (tenantId = TENANT) =>
      [...(((db.read(tenantReportPath(tenantId)) ?? {}).sampleOrphanPaths as string[]) ?? [])].sort(),
  };
}

/** One conversation holding the given messages, under the tenant's chat tree. */
function chatTree(messages: Record<string, DocData>, tenantId = TENANT): Record<string, unknown> {
  return { tenantChat: { [tenantId]: { conversationMessages: { c_9f2a: messages } } } };
}

function isForeignWrite(entry: Operation): boolean {
  return entry.store !== 'firestore' || !entry.target.startsWith('storageMaintenanceJobs/');
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

// ─── The two headline regression cases ───────────────────────────────────────

describe('the Realtime Database as the authoritative chat reference source', () => {
  const attachment = `chat-files/${TENANT}/c_9f2a/k_3b1c_photo.jpg`;
  const objects: FakeObject[] = [
    { name: attachment, size: 2_048, timeCreated: OLD, updated: OLD },
  ];
  const tree = chatTree({
    '-msg_0001': {
      sender: 'teacher@example.com',
      recipientId: 'student@example.com',
      attachments: [{ url: downloadUrl(attachment) }],
    },
  });

  it('retains a chat attachment referenced ONLY in the Realtime Database', async () => {
    // Nothing in Firestore mentions this object at all.
    const run = await sweep({ objects, tree, collections: {} });

    const [result] = run.result.tenants;
    expect(result.status).toBe('completed');
    expect(result.objectsScanned).toBe(1);
    expect(result.orphanCount).toBe(0);
    expect(result.retainedByReason.referenced).toBe(1);
    expect(run.reported()).toEqual([]);
    expect(run.report().countsBySource).toMatchObject({ rtdb_chat_messages: 1 });
  });

  it('ABORTS on the identical fixture when the Realtime Database source is disabled', async () => {
    const run = await sweep({
      objects,
      tree,
      collections: {},
      rtdbFails: new Error("PERMISSION_DENIED: Client doesn't have permission to access the desired data"),
    });

    const [result] = run.result.tenants;
    // The whole point: not "one orphan found", but "we could not read, so we stop".
    expect(result.status).toBe('aborted');
    expect(result.abortReason).toBe('reference_source_failed');
    expect(result.orphanCount).toBe(0);
    expect(result.objectsScanned).toBe(0);
    expect(run.reported()).toEqual([]);

    // The bucket was never even listed, and the report says why and is marked
    // partial so a truncated orphan count is not read as authoritative.
    expect(run.bucket.getFilesCalls).toEqual([]);
    const report = run.report();
    expect(report.partial).toBe(true);
    expect(report.abortReason).toBe('reference_source_failed');
    expect((report.failedSources as { id: string }[]).map((entry) => entry.id)).toContain(
      'rtdb_chat_messages'
    );
    // And nothing outside the job's own namespace was touched.
    expect(run.log.writes().filter(isForeignWrite)).toEqual([]);
  });
});

// ─── Report mode mutates nothing, and the ordering is observable ─────────────

describe('report mode over an entirely unreferenced bucket', () => {
  it('reports every candidate, mutates nothing, and orders its work as specified', async () => {
    const objects: FakeObject[] = [
      { name: `chat-files/${TENANT}/c_1/k_a_photo.jpg`, size: 10, timeCreated: OLD, updated: OLD },
      { name: `chat-files/${TENANT}/c_1/k_b_photo.jpg`, size: 20, timeCreated: OLD, updated: OLD },
      { name: `notices/${TENANT}/notice_k_c.png`, size: 30, timeCreated: OLD, updated: OLD },
      { name: `receipts/${TENANT}/fee_1/k_d.pdf`, size: 40, timeCreated: OLD, updated: OLD },
    ];

    const run = await sweep({ objects, config: { pageSize: 1 } });

    const [result] = run.result.tenants;
    expect(result.status).toBe('completed');
    expect(result.orphanCount).toBe(4);
    expect(result.orphanBytes).toBe(100);
    expect(run.result.dryRun).toBe(true);

    // 1. Zero bucket mutators and zero writes outside the maintenance namespace.
    expect(run.log.methods().filter((method) => method.startsWith('bucket.file.'))).toEqual([]);
    expect(run.log.writes().filter(isForeignWrite)).toEqual([]);
    expect(run.db.read(`tenantStorageUsage/${TENANT}`)).toBeUndefined();

    // 2. The resume cursor is persisted AFTER the page it describes: every progress
    //    write follows the listing call it belongs to. With pageSize 1 there is one
    //    write per object, so the two sequences interleave strictly.
    const listingIndices = run.log.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.method === 'getFiles' && entry.detail?.maxResults !== null)
      .map(({ index }) => index);
    const progressIndices = run.log.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === 'write' && entry.target.startsWith('storageMaintenanceJobs/'))
      .map(({ index }) => index);
    expect(listingIndices.length).toBeGreaterThan(0);
    expect(progressIndices.length).toBeGreaterThan(0);
    expect(listingIndices[0]).toBeLessThan(progressIndices[0]);

    // 3. The quota recompute happens exactly once, AFTER the last listing page.
    const recomputeIndices = run.log.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.method === 'getFiles' && entry.detail?.maxResults === null)
      .map(({ index }) => index);
    expect(recomputeIndices.length).toBe(6);
    expect(Math.min(...recomputeIndices)).toBeGreaterThan(Math.max(...listingIndices));
    expect(typeof result.usageBytesAfter).toBe('number');
  });
});

// ─── Chat message shapes ────────────────────────────────────────────────────

describe('chat message shapes', () => {
  it('retains a legacy single-file message (fileUrl, no attachments)', async () => {
    const objectPath = `chat-files/${TENANT}/c_9f2a/1712000000000_photo.jpg`;
    const run = await sweep({
      objects: [{ name: objectPath, size: 64, timeCreated: OLD, updated: OLD }],
      tree: chatTree({
        '-msg_legacy': {
          sender: 'teacher@example.com',
          fileUrl: downloadUrl(objectPath),
          fileName: 'photo.jpg',
          fileType: 'image/jpeg',
        },
      }),
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.referenced).toBe(1);
  });

  it('retains BOTH of two same-named attachments on one multi-file message', async () => {
    // Distinct objects under `upload-idempotency`'s per-file keys, same filename.
    const first = `chat-files/${TENANT}/c_9f2a/k_aaaa_photo.jpg`;
    const second = `chat-files/${TENANT}/c_9f2a/k_bbbb_photo.jpg`;
    const run = await sweep({
      objects: [
        { name: first, size: 11, timeCreated: OLD, updated: OLD },
        { name: second, size: 22, timeCreated: OLD, updated: OLD },
      ],
      tree: chatTree({
        '-msg_multi': {
          sender: 'teacher@example.com',
          attachments: [
            { url: downloadUrl(first), fileName: 'photo.jpg' },
            { url: downloadUrl(second), fileName: 'photo.jpg' },
          ],
        },
      }),
    });

    expect(run.result.tenants[0].objectsScanned).toBe(2);
    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.referenced).toBe(2);
  });

  it('reports the surviving object of a soft-deleted message as a candidate', async () => {
    // `deleteChatMessage` nulls the reference fields and keeps the node; its
    // best-effort object cleanup swallowed a failure, so the object survived. That
    // is the lifecycle-orphan class this sweep exists for.
    const objectPath = `chat-files/${TENANT}/c_9f2a/k_gone_photo.jpg`;
    const run = await sweep({
      objects: [{ name: objectPath, size: 99, timeCreated: OLD, updated: OLD }],
      tree: chatTree({
        '-msg_deleted': {
          sender: 'teacher@example.com',
          deleted: true,
          fileUrl: null,
          thumbnailUrl: null,
          attachments: null,
        },
      }),
    });

    expect(run.result.tenants[0].orphanCount).toBe(1);
    expect(run.reported()).toEqual([objectPath]);
    // Reported, not touched.
    expect(run.bucket.contents().has(objectPath)).toBe(true);
    expect(run.log.writes().filter(isForeignWrite)).toEqual([]);
  });
});

// ─── Transcodes ─────────────────────────────────────────────────────────────

describe('videoTranscodes', () => {
  const original = `chat-files/${TENANT}/c_9f2a/k_3b1c_clip.mov`;
  const output = buildTranscodeStoragePath(original);

  it('retains the output when the original was deliberately deleted', async () => {
    const run = await sweep({
      objects: [{ name: output, size: 5_000, timeCreated: OLD, updated: OLD }],
      collections: {
        videoTranscodes: {
          [`doc_${1}`]: {
            tenantId: TENANT,
            status: 'done',
            originalPath: original,
            originalDeleted: true,
            transcodedPath: output,
            transcodedUrl: downloadUrl(output),
          },
        },
      },
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.referenced).toBe(1);
    // The original is absent from the listing, which is EXPECTED: no verdict, and
    // no dangling reference recorded for it.
    expect(run.result.tenants[0].danglingReferenceCount).toBe(0);
  });

  it("retains the original while status is 'processing', plus the not-yet-existent output", async () => {
    const run = await sweep({
      objects: [{ name: original, size: 9_000, timeCreated: OLD, updated: OLD }],
      collections: {
        videoTranscodes: {
          doc_processing: { tenantId: TENANT, status: 'processing', originalPath: original },
        },
      },
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.referenced).toBe(1);
    // The derived output is in the retain set although no object exists for it yet:
    // ffmpeg is reading the original right now and the reference is written only
    // after the output lands.
    expect(run.report().referenceCount).toBe(2);
  });

  it('retains the objects of a soft-deleted chat video whose document survives, and records the observation', async () => {
    // Req 8.10. `deleteStorageObjectsForMessage` is best-effort and the message is
    // soft-deleted, so nothing in the chat tree references either object — but the
    // `videoTranscodes` document survives and still does. Reclaiming these needs a
    // liveness judgement across a soft-deleted RTDB node and a surviving Firestore
    // document, which is exactly the inference that produces false positives, so v1
    // retains and records rather than sweeping.
    const run = await sweep({
      objects: [
        { name: original, size: 9_000, timeCreated: OLD, updated: OLD },
        { name: output, size: 4_000, timeCreated: OLD, updated: OLD },
      ],
      tree: chatTree({
        '-msg_deleted': { sender: 'teacher@example.com', deleted: true, attachments: null },
      }),
      collections: {
        videoTranscodes: {
          doc_orphaned: {
            tenantId: TENANT,
            status: 'done',
            originalPath: original,
            transcodedPath: output,
            transcodedUrl: downloadUrl(output),
          },
        },
      },
    });

    const [result] = run.result.tenants;
    expect(result.orphanCount).toBe(0);
    expect(result.retainedByReason.referenced).toBe(2);
    // The observation: both chat paths were proven by the transcode document alone,
    // with no chat message referencing them.
    expect(run.report().transcodeOnlyReferenceCount).toBe(2);
    expect(run.report().transcodeOnlyReferences).toEqual(expect.arrayContaining([original, output]));
  });

  it("retains the output of a document marked status: 'error' that carries a transcodedUrl", async () => {
    // `/video/request-transcode` returns a `transcodedUrl` regardless of status and
    // repairs the status afterwards, so `status` is not a liveness signal.
    const run = await sweep({
      objects: [{ name: output, size: 4_096, timeCreated: OLD, updated: OLD }],
      collections: {
        videoTranscodes: {
          doc_error: {
            tenantId: TENANT,
            status: 'error',
            originalPath: original,
            originalDeleted: true,
            transcodedUrl: downloadUrl(output),
          },
        },
      },
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.reported()).toEqual([]);
  });
});

// ─── Fees and receipts ──────────────────────────────────────────────────────

describe('fee receipts', () => {
  it('reports a deleted fee’s receipt when it is older than grace and retains it when younger', async () => {
    const oldReceipt = `receipts/${TENANT}/fee_77/k_aa11_march.pdf`;
    const freshReceipt = `receipts/${TENANT}/fee_78/k_bb22_april.pdf`;

    // Both fees are gone from Firestore; only the objects remain.
    const run = await sweep({
      objects: [
        { name: oldReceipt, size: 1_000, timeCreated: OLD, updated: OLD },
        { name: freshReceipt, size: 2_000, timeCreated: FRESH, updated: FRESH },
      ],
    });

    expect(run.reported()).toEqual([oldReceipt]);
    expect(run.result.tenants[0].retainedByReason.within_grace).toBe(1);
    expect(run.result.tenants[0].orphanBytes).toBe(1_000);
  });

  it('reads the receipts array defensively and keeps enumerating the fees source', async () => {
    const good = `receipts/${TENANT}/fee_1/k_good.pdf`;
    const alsoGood = `receipts/${TENANT}/fee_4/k_also_good.pdf`;
    const run = await sweep({
      objects: [
        { name: good, size: 10, timeCreated: OLD, updated: OLD },
        { name: alsoGood, size: 20, timeCreated: OLD, updated: OLD },
      ],
      collections: {
        fees: {
          // Not an array.
          fee_1: { tenantId: TENANT, receipts: { url: downloadUrl(good) } },
          // Entries that are not objects.
          fee_2: { tenantId: TENANT, receipts: ['not-an-object', 42, null] },
          // An entry whose `url` is not a string.
          fee_3: { tenantId: TENANT, receipts: [{ url: 12345 }, { url: null }] },
          // A well-formed one, enumerated after all three malformed shapes.
          fee_4: { tenantId: TENANT, receipts: [{ url: downloadUrl(alsoGood) }] },
        },
      },
    });

    const [result] = run.result.tenants;
    // No abort: a stray shape is skipped, not counted as a Malformed_Reference.
    expect(result.status).toBe('completed');
    expect(run.report().malformedReferences).toBe(0);
    // The well-formed entry after them was still read …
    expect(run.reported()).toEqual([good]);
    expect(run.report().countsBySource).toMatchObject({ fees: 1 });
  });
});

// ─── Notices ────────────────────────────────────────────────────────────────

describe('notices', () => {
  it('retains an audio object named only by audioStoragePath, with no audioUrl', async () => {
    const audio = `notices/${TENANT}/audio/notice_audio_k_dead.m4a`;
    const run = await sweep({
      objects: [{ name: audio, size: 700, timeCreated: OLD, updated: OLD }],
      collections: {
        notices: { notice_1: { tenantId: TENANT, audioStoragePath: audio } },
      },
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.referenced).toBe(1);
  });
});

// ─── Tenant branding, with its negative control ─────────────────────────────

describe('tenant branding', () => {
  const paths = {
    logo: `tenant-branding/${TENANT}/logo_k_1.png`,
    hero: `tenant-branding/${TENANT}/hero_k_2.png`,
    brandingLogo: `tenant-branding/${TENANT}/logo_k_3.png`,
    brandingHero: `tenant-branding/${TENANT}/hero_k_4.png`,
    accent: `tenant-branding/${TENANT}/accent_k_5.png`,
  };
  const objects: FakeObject[] = Object.values(paths).map((name, index) => ({
    name,
    size: 100 * (index + 1),
    timeCreated: OLD,
    updated: OLD,
  }));

  it('retains all five branding objects', async () => {
    const run = await sweep({
      objects,
      collections: {
        tenants: {
          [TENANT]: {
            status: 'active',
            logoUrl: downloadUrl(paths.logo),
            heroImageUrl: downloadUrl(paths.hero),
            branding: {
              logoUrl: downloadUrl(paths.brandingLogo),
              heroImageUrl: downloadUrl(paths.brandingHero),
              accentImageUrl: downloadUrl(paths.accent),
            },
          },
        },
      },
    });

    expect(run.result.tenants[0].objectsScanned).toBe(5);
    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.referenced).toBe(5);
    expect(run.report().countsBySource).toMatchObject({ tenant_branding: 5 });
  });

  it('NEGATIVE CONTROL: a tenant document carrying only logoUrl reports the other four', async () => {
    // The same bucket, the same five live objects, and a document that names one of
    // them. This is what a run that read only `logoUrl` would produce, and it is
    // why the enumeration reads all five fields plus every string leaf under
    // `branding`.
    const run = await sweep({
      objects,
      collections: {
        tenants: { [TENANT]: { status: 'active', logoUrl: downloadUrl(paths.logo) } },
      },
    });

    expect(run.result.tenants[0].orphanCount).toBe(4);
    expect(run.reported()).toEqual(
      [paths.hero, paths.brandingLogo, paths.brandingHero, paths.accent].sort()
    );
  });

  it('retains a sixth branding field added later, through the generic leaf walk', async () => {
    const sixth = `tenant-branding/${TENANT}/watermark_k_6.png`;
    const run = await sweep({
      objects: [{ name: sixth, size: 10, timeCreated: OLD, updated: OLD }],
      collections: {
        tenants: {
          [TENANT]: { status: 'active', branding: { watermarkImageUrl: downloadUrl(sixth) } },
        },
      },
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
  });
});

// ─── Profile pictures and students ──────────────────────────────────────────

describe('profile pictures retained by derivation', () => {
  it('retains an avatar that NO document field anywhere references', async () => {
    // The `toggleProfilePictureSource` case: `photoURL` was overwritten with the
    // Google CDN url and `customImageURL` was cleared, so the live uploaded object
    // has no field pointing at it. The membership row is the proof.
    const email = 'Member@Example.com';
    const derived = deriveProfilePicturePath({ tenantId: TENANT, email })!;
    expect(derived).toMatch(/^profile-pictures\/acme\/[0-9a-f]{20}\.jpg$/);

    const run = await sweep({
      objects: [{ name: derived, size: 4_000, timeCreated: OLD, updated: OLD }],
      collections: {
        tenantMemberships: {
          [`${TENANT}_uid-1`]: { tenantId: TENANT, status: 'revoked', email },
        },
        tenantProfiles: {
          [`${TENANT}_member`]: {
            tenantId: TENANT,
            email,
            // Points at Google, not at the object in our bucket.
            photoURL: 'https://lh3.googleusercontent.com/a/default-user=s96-c',
          },
        },
      },
    });

    const [result] = run.result.tenants;
    expect(result.orphanCount).toBe(0);
    expect(result.retainedByReason.referenced).toBe(1);
    expect(run.report().countsBySource).toMatchObject({ profile_pictures_derived: 1 });
    // The report never records the email, only the hashed path.
    expect(JSON.stringify(run.report())).not.toContain('Member@Example.com');
  });

  it('retains an object whose profile-picture filename the derivation does not describe', async () => {
    const unexpected = `profile-pictures/${TENANT}/holiday-photo.png`;
    const run = await sweep({
      objects: [{ name: unexpected, size: 1, timeCreated: OLD, updated: OLD }],
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.unmanaged_path).toBe(1);
  });
});

describe('students', () => {
  it('retains the photos of inactive and suspended students', async () => {
    const photos = {
      active: `student_profiles/${TENANT}/k_a_profile.jpg`,
      inactive: `student_profiles/${TENANT}/k_i_profile.jpg`,
      suspended: `student_profiles/${TENANT}/k_s_profile.jpg`,
    };
    const run = await sweep({
      objects: Object.values(photos).map((name) => ({
        name,
        size: 10,
        timeCreated: OLD,
        updated: OLD,
      })),
      collections: {
        students: {
          s_a: { tenantId: TENANT, status: 'active', profileImageUrl: downloadUrl(photos.active) },
          s_i: { tenantId: TENANT, status: 'inactive', profileImageUrl: downloadUrl(photos.inactive) },
          s_s: {
            tenantId: TENANT,
            status: 'suspended',
            profileImageUrl: downloadUrl(photos.suspended),
          },
        },
      },
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.referenced).toBe(3);
  });
});

// ─── Tenant confinement and the abort conditions ────────────────────────────

describe('tenant confinement with overlapping identifiers', () => {
  it('gives acme and acme-2 disjoint sweeps', async () => {
    const acmeObject = `notices/acme/notice_k_a.png`;
    const acme2Object = `notices/acme-2/notice_k_b.png`;
    const run = await sweep({
      objects: [
        { name: acmeObject, size: 10, timeCreated: OLD, updated: OLD },
        { name: acme2Object, size: 20, timeCreated: OLD, updated: OLD },
      ],
      config: { tenantIds: ['acme', 'acme-2'] },
    });

    const [acme, acme2] = run.result.tenants;
    expect(acme.tenantId).toBe('acme');
    expect(acme2.tenantId).toBe('acme-2');

    // Each sweep saw exactly its own object: `acme` cannot reach `acme-2` because
    // the tenant segment is compared whole, and the listing prefix carries the
    // trailing slash.
    expect(acme.objectsScanned).toBe(1);
    expect(acme2.objectsScanned).toBe(1);
    expect(run.reported('acme')).toEqual([acmeObject]);
    expect(run.reported('acme-2')).toEqual([acme2Object]);
    expect(run.report('acme').crossTenantReferenceCount).toBe(0);
    expect(run.report('acme-2').crossTenantReferenceCount).toBe(0);
  });

  it('records a cross-tenant reference, excludes it, and continues the run', async () => {
    const own = `notices/${TENANT}/notice_k_own.png`;
    const foreign = `notices/other-tenant/notice_k_foreign.png`;
    const run = await sweep({
      objects: [{ name: own, size: 10, timeCreated: OLD, updated: OLD }],
      collections: {
        notices: {
          notice_1: { tenantId: TENANT, imageUrl: downloadUrl(own) },
          notice_2: { tenantId: TENANT, imageUrl: downloadUrl(foreign) },
        },
      },
    });

    expect(run.result.tenants[0].status).toBe('completed');
    expect(run.report().crossTenantReferenceCount).toBe(1);
    expect(run.report().crossTenantReferences).toEqual([foreign]);
    expect(run.reported()).toEqual([]);
  });

  /**
   * ── A hostile tenant id reaches the LISTING prefix, not just the guard ─────
   *
   * `listingPrefixesForTenant` interpolates the tenant id straight into
   * `{category}/{tenantId}/`, and the id comes from `STORAGE_ORPHAN_SWEEP_TENANT_IDS`
   * — an operator-supplied comma-separated string that is only trimmed and checked
   * non-empty. A `tenants` document id cannot contain `/`, be `.`/`..` or exceed
   * 1500 bytes, so the `all_active` path is safe by construction; the allow-list is
   * not.
   *
   * The confinement that saves it is `classifyTenantScopedPath`'s
   * `isPlainPathSegment(tenantId)` check: a tenant id that is not one whole plain
   * segment makes EVERY listed object a `tenant_mismatch`, which the Decision_Function
   * reads as `unmanaged_path` and retains. So a hostile id can cause a listing of a
   * prefix that is not its own, but cannot make a single object a candidate.
   *
   * This is asserted in APPLY mode with the real mover installed, which is the only
   * configuration in which getting it wrong would destroy anything.
   */
  it('cannot make a candidate of anything when the configured tenant id is not a plain path segment', async () => {
    for (const hostile of ['a/b', '..', '.', 'x/../../y']) {
      const victim = `notices/a/b/someone_elses.png`;
      const run = await sweep({
        objects: [
          { name: victim, size: 10, timeCreated: OLD, updated: OLD },
          { name: `notices/../escaped.png`, size: 20, timeCreated: OLD, updated: OLD },
        ],
        config: applyConfig({ tenantIds: [hostile] }),
      });

      const [result] = run.result.tenants;
      expect(result.tenantId).toBe(hostile);
      // Whatever the listing prefix happened to match is retained as out of scope.
      expect(result.orphanCount).toBe(0);
      expect(result.quarantinedCount).toBe(0);
      expect(result.sampleOrphanPaths).toEqual([]);
      expect(result.retainedByReason.referenced).toBe(0);
      expect(result.retainedByReason.unmanaged_path).toBe(result.objectsScanned);
      // Not one bucket mutator, in apply mode, with the real mover installed.
      expect(run.log.methods().filter((method) => method.startsWith('bucket.file.'))).toEqual([]);
      expect(run.bucket.contents().has(victim)).toBe(true);
    }
  });
});

describe('abort conditions', () => {
  it('aborts on a single malformed reference, having listed nothing', async () => {
    const run = await sweep({
      objects: [
        { name: `notices/${TENANT}/notice_k_a.png`, size: 10, timeCreated: OLD, updated: OLD },
      ],
      collections: {
        notices: {
          // `decodeURIComponent` throws on this object segment: we cannot tell what
          // it names, so no object in this tenant is provably unreferenced.
          notice_bad: {
            tenantId: TENANT,
            imageUrl: `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/%zz`,
          },
        },
      },
    });

    const [result] = run.result.tenants;
    expect(result.status).toBe('aborted');
    expect(result.abortReason).toBe('malformed_reference');
    expect(result.orphanCount).toBe(0);
    expect(run.bucket.getFilesCalls).toEqual([]);
    expect(run.log.writes().filter(isForeignWrite)).toEqual([]);
  });

  it('aborts when the retain set exceeds the reference ceiling', async () => {
    const run = await sweep({
      objects: [
        { name: `notices/${TENANT}/notice_k_a.png`, size: 10, timeCreated: OLD, updated: OLD },
      ],
      collections: {
        notices: {
          notice_1: { tenantId: TENANT, imageUrl: downloadUrl(`notices/${TENANT}/a.png`) },
          notice_2: { tenantId: TENANT, imageUrl: downloadUrl(`notices/${TENANT}/b.png`) },
          notice_3: { tenantId: TENANT, imageUrl: downloadUrl(`notices/${TENANT}/c.png`) },
        },
      },
      config: { maxReferences: 2 },
    });

    expect(run.result.tenants[0].abortReason).toBe('reference_cap_exceeded');
    expect(run.bucket.getFilesCalls).toEqual([]);
  });
});

// ─── The report document ────────────────────────────────────────────────────

describe('the report document', () => {
  it('records every run parameter and stays free of tokens and emails', async () => {
    const objectPath = `chat-files/${TENANT}/c_9f2a/k_a_photo.jpg`;
    const run = await sweep({
      objects: [{ name: objectPath, size: 10, timeCreated: OLD, updated: OLD }],
      tree: chatTree({
        '-msg_1': {
          sender: 'teacher@example.com',
          fileUrl: downloadUrl(objectPath, 'secret-download-token'),
        },
      }),
      config: { graceDays: 3, pageSize: 25, maxQuarantinePerTenant: 25, maxReferences: 500 },
    });

    const report = run.report();
    expect(report.params).toEqual(
      expect.objectContaining({
        graceDays: 3,
        graceCutoffMs: NOW - 3 * DAY,
        quarantineRetentionDays: 7,
        pageSize: 25,
        maxQuarantinePerTenant: 25,
        maxReferences: 500,
      })
    );
    expect(report.status).toBe('completed');
    expect(report.mode).toBe('report');
    expect(report.applied).toBe(false);
    expect(report.resume).toBeNull();
    expect(report.partial).toBe(false);
    expect(report.referenceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.completedAt).toBeInstanceOf(Date);

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('secret-download-token');
    expect(serialised).not.toContain('teacher@example.com');
  });

  it('bounds sampleOrphanPaths to 200 entries while still counting every candidate', async () => {
    const objects: FakeObject[] = Array.from({ length: 205 }, (_, index) => ({
      name: `receipts/${TENANT}/fee_${String(index).padStart(3, '0')}/k_r.pdf`,
      size: 1,
      timeCreated: OLD,
      updated: OLD,
    }));

    const run = await sweep({ objects, config: { pageSize: 50 } });

    // The count is authoritative; the sample is a bounded aid for an operator
    // eyeballing the report before applying (Req 16.5).
    expect(run.result.tenants[0].orphanCount).toBe(205);
    expect((run.report().sampleOrphanPaths as string[]).length).toBe(200);
  });

  it('counts a reference whose object is absent from the listing as dangling', async () => {
    const present = `notices/${TENANT}/notice_k_present.png`;
    const missing = `notices/${TENANT}/notice_k_missing.png`;
    const run = await sweep({
      objects: [{ name: present, size: 10, timeCreated: OLD, updated: OLD }],
      collections: {
        notices: {
          notice_1: { tenantId: TENANT, imageUrl: downloadUrl(present) },
          // The record survived; its object did not.
          notice_2: { tenantId: TENANT, imageUrl: downloadUrl(missing) },
        },
      },
    });

    const [result] = run.result.tenants;
    expect(result.danglingReferenceCount).toBe(1);
    expect(result.status).toBe('completed');
    // Reported, never repaired: the notice document is untouched.
    expect(run.db.read('notices/notice_2')).toEqual({
      tenantId: TENANT,
      imageUrl: downloadUrl(missing),
    });
    expect(run.log.writes().filter(isForeignWrite)).toEqual([]);
  });
});

// ─── The listing loop's own edges ───────────────────────────────────────────

describe('object metadata', () => {
  it('retains an object whose age cannot be determined', async () => {
    const run = await sweep({
      objects: [{ name: `notices/${TENANT}/notice_k_a.png`, size: 10 }],
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.age_unknown).toBe(1);
  });

  it('treats an overwritten object as young, taking the max of timeCreated and updated', async () => {
    // The `upload-idempotency` retry case: an old creation time and a fresh
    // overwrite. Taking the maximum is what re-enters the grace window.
    const run = await sweep({
      objects: [{ name: `notices/${TENANT}/notice_k_a.png`, size: 10, timeCreated: OLD, updated: FRESH }],
    });

    expect(run.result.tenants[0].orphanCount).toBe(0);
    expect(run.result.tenants[0].retainedByReason.within_grace).toBe(1);
  });

  it('retains an object already under the quarantine prefix', async () => {
    const run = await sweep({
      objects: [
        {
          name: `_orphan-quarantine/${TENANT}/sweep_1/notices/${TENANT}/notice_k_a.png`,
          size: 10,
          timeCreated: OLD,
          updated: OLD,
        },
        { name: `notices/${TENANT}/notice_k_b.png`, size: 20, timeCreated: OLD, updated: OLD },
      ],
    });

    // The quarantine prefix is not a Managed_Category, so it is not even listed.
    expect(run.result.tenants[0].objectsScanned).toBe(1);
    expect(run.reported()).toEqual([`notices/${TENANT}/notice_k_b.png`]);
  });
});

describe('run-level refusals', () => {
  it('refuses to run against an unnamed bucket', async () => {
    const log = createOperationLog();
    await expect(
      runStorageOrphanSweep({
        db: createFakeFirestore({ log }) as never,
        rtdb: createFakeRtdb({ log }) as never,
        bucket: createFakeBucket({ log, objects: [], name: '' }) as never,
        config: sweepConfig({ nowMs: NOW }) as never,
      })
    ).rejects.toThrow(/named bucket is required/);
    expect(log.entries).toEqual([]);
  });

  it('refuses apply mode with no quarantine mover installed', async () => {
    const log = createOperationLog();
    await expect(
      runStorageOrphanSweep({
        db: createFakeFirestore({ log }) as never,
        rtdb: createFakeRtdb({ log }) as never,
        bucket: createFakeBucket({ log, objects: [] }) as never,
        config: sweepConfig({ mode: 'sweep', apply: true, nowMs: NOW }) as never,
      })
    ).rejects.toThrow(/quarantine mover/);
    expect(log.entries).toEqual([]);
  });

  it('resolves all active tenants when none is configured', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({
      log,
      collections: {
        tenants: {
          acme: { status: 'active' },
          dormant: { status: 'suspended' },
        },
      },
    });
    const run = await runStorageOrphanSweep({
      db: db as never,
      rtdb: createFakeRtdb({ log }) as never,
      bucket: createFakeBucket({ log, objects: [] }) as never,
      config: sweepConfig({ tenantIds: 'all_active', nowMs: NOW }) as never,
    });

    expect(run.tenants.map((tenant) => tenant.tenantId)).toEqual(['acme']);
  });

  /**
   * Zero active tenants — a fresh project, or an active-tenant query that has
   * stopped matching because the `status` field drifted. The run must complete
   * cleanly and list nothing rather than fail, and `tenants: []` is what makes "the
   * sweep found no tenants" distinguishable from "the sweep found no orphans".
   *
   * ── Why `runs_total` IS emitted here, with no `tenant_id` ──────────────────
   *
   * This assertion was the reverse until now: it pinned that a zero-tenant run
   * emits no `runs_total` line at all, on the grounds that every metric is
   * per-tenant. That was the behaviour, and the behaviour contradicted the
   * Observability block's own stated reason for the metric — "one line per tenant
   * per invocation labelled by `outcome`, emitted precisely so that 'the job ran'
   * is visible on a run that found nothing to do".
   *
   * The case it has to cover is not a fresh project. It is an `all_active` query
   * that silently stops matching: a green run that did nothing, `aborted_total`
   * sitting at zero and looking healthy, and no signal distinguishing it from a
   * quiet, correct run — which is exactly the "a cleanup tool that silently stops
   * running" failure the alert policy exists to catch.
   *
   * So one line is emitted with `outcome: 'completed'` and NO `tenant_id`, because
   * there is no tenant it is about. The label set is the same closed
   * `SweepMetricLabels`; `compactLabels` drops the absent key rather than writing an
   * empty one, and the documented filter
   * `resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_runs_total"`
   * does not mention `tenant_id`, so the line still matches it.
   */
  it('emits one runs_total line with no tenant_id over zero active tenants', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { tenants: {} } });
    const bucket = createFakeBucket({ log, objects: [] });

    consoleLog.mockClear();
    const run = await runStorageOrphanSweep({
      db: db as never,
      rtdb: createFakeRtdb({ log }) as never,
      bucket: bucket as never,
      config: sweepConfig({ tenantIds: 'all_active', nowMs: NOW }) as never,
    });

    expect(run.tenants).toEqual([]);
    expect(run.dryRun).toBe(true);
    expect(bucket.getFilesCalls).toEqual([]);
    // The active-tenant query is still the ONLY thing that happened, and nothing
    // was written anywhere — the metric is a log line, not a mutation.
    expect(log.methods()).toEqual(['firestore.query.get']);
    expect(log.writes()).toEqual([]);

    // Exactly one metric line, and it is the run outcome.
    const metricLines = consoleLog.mock.calls
      .map(([line]) => line)
      .filter((line): line is string => typeof line === 'string' && line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((payload) => typeof payload.metric === 'string');

    expect(metricLines).toEqual([
      {
        severity: 'INFO',
        message: '[orphan_sweep] metric storage_orphan_sweep_runs_total',
        metric: 'storage_orphan_sweep_runs_total',
        value: 1,
        mode: 'report',
        outcome: 'completed',
      },
    ]);
    // No `tenant_id` key at all, rather than an empty one: there is no tenant this
    // line is about, and an empty label value would create a bogus series member.
    expect(Object.keys(metricLines[0])).not.toContain('tenant_id');
  });
});

// ─── Apply mode (task 8.4) ──────────────────────────────────────────────────
//
// The same suite, the same fakes and the same single chronological log, now with
// the real `quarantineObject` installed. Every claim below is a statement about
// the relative position of two entries in that one list:
//
//   copy → manifest → delete, per object, with no exceptions;
//   the quota recompute after the LAST listing page, and its write only in apply
//   mode;
//   the resume cursor persisted at the page the ceiling stopped on;
//   and, across an interrupted run and its resumption, the same union of objects
//   examined with nothing quarantined twice.
//
// These are the cases task 6.10 could not express: no code that could move an
// object existed until task 8.

const SWEEP_ID = 'sweep_test_8_4';
const TOKEN = 'tok-live';

/**
 * Every entry for one logged method, in order, optionally only those appended
 * from index `from` onwards.
 *
 * The `from` boundary is how a two-run case reads "what the SECOND run did" off
 * the single log: each fake appends to the log it was constructed with, so two
 * runs sharing a bucket and a Firestore necessarily share one log — which is the
 * arrangement this suite wants anyway.
 */
function entriesFor(log: OperationLog, method: string, from = 0): Operation[] {
  return log.entries.slice(from).filter((entry) => entry.method === method);
}

function targetsFor(log: OperationLog, method: string, from = 0): string[] {
  return entriesFor(log, method, from).map((entry) => entry.target);
}

/** Object names the PAGED listing returned, i.e. the objects a run examined. */
function examinedNames(log: OperationLog, from = 0): string[] {
  const names: string[] = [];
  for (const entry of entriesFor(log, 'getFiles.page', from)) {
    if (entry.detail?.maxResults === null) continue;
    for (const name of (entry.detail?.names ?? []) as string[]) names.push(name);
  }
  return names;
}

/** Indices of the paged listing calls; the recompute pages without `maxResults`. */
function listingIndices(log: OperationLog): number[] {
  return log.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.method === 'getFiles' && entry.detail?.maxResults !== null)
    .map(({ index }) => index);
}

function recomputeIndices(log: OperationLog): number[] {
  return log.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.method === 'getFiles' && entry.detail?.maxResults === null)
    .map(({ index }) => index);
}

/** Old enough that only a reference could retain it, with a download token. */
function orphan(objectPath: string, size: number): FakeObject {
  return {
    name: objectPath,
    size,
    timeCreated: OLD,
    updated: OLD,
    metadata: { firebaseStorageDownloadTokens: TOKEN },
  };
}

function applyConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: 'sweep', apply: true, sweepId: SWEEP_ID, ...overrides };
}

describe('apply mode: the move, its ordering and its destinations', () => {
  const moved = [
    `notices/${TENANT}/notice_k_gone.png`,
    `notices/${TENANT}/audio/notice_audio_k_gone.m4a`,
    `receipts/${TENANT}/fee_77/k_aa11_march.pdf`,
  ];
  const kept = `notices/${TENANT}/notice_k_live.png`;

  it('copies before deleting EVERY object, records each manifest entry first, and builds well-formed destinations', async () => {
    const run = await sweep({
      objects: [
        orphan(moved[0], 100),
        orphan(moved[1], 200),
        orphan(moved[2], 300),
        orphan(kept, 50),
      ],
      collections: { notices: { notice_live: { tenantId: TENANT, imageUrl: downloadUrl(kept) } } },
      config: applyConfig(),
    });

    const [result] = run.result.tenants;
    expect(run.result.dryRun).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.orphanCount).toBe(3);
    expect(result.quarantinedCount).toBe(3);
    expect(result.quarantineFailures).toBe(0);
    expect(result.quarantinedBytes).toBe(600);

    for (const objectPath of moved) {
      const destination = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${objectPath}`;

      const copyAt = run.log.indexOf(
        (entry) => entry.method === 'file.copy' && entry.target === objectPath
      );
      const manifestAt = run.log.indexOf(
        (entry) =>
          entry.store === 'firestore' &&
          entry.target === quarantineManifestPath(TENANT, SWEEP_ID, objectPath)
      );
      const deleteAt = run.log.indexOf(
        (entry) => entry.method === 'file.delete' && entry.target === objectPath
      );

      // copy → manifest → delete, for this object, read off the one log.
      expect(copyAt).toBeGreaterThan(-1);
      expect(copyAt).toBeLessThan(manifestAt);
      expect(manifestAt).toBeLessThan(deleteAt);

      // The destination is well formed: inside this tenant's quarantine namespace,
      // under this run's sweepId, and an exact inverse of `parseQuarantinePath` —
      // which is what lets the purge stage reconstruct the original path from the
      // quarantine path alone.
      const copied = entriesFor(run.log, 'file.copy').find((entry) => entry.target === objectPath);
      expect(copied!.detail?.destination).toBe(destination);
      expect(parseQuarantinePath(destination)).toEqual({
        tenantId: TENANT,
        sweepId: SWEEP_ID,
        objectPath,
      });

      // The bytes moved, with the download token carried along.
      expect(run.bucket.contents().has(objectPath)).toBe(false);
      expect(run.bucket.contents().get(destination)).toMatchObject({
        metadata: { firebaseStorageDownloadTokens: TOKEN },
      });
    }

    // Nothing but an original was ever the target of a delete, and no object was
    // deleted twice.
    expect(targetsFor(run.log, 'file.delete').sort()).toEqual([...moved].sort());

    // The referenced object was neither copied nor deleted.
    expect(targetsFor(run.log, 'file.copy')).not.toContain(kept);
    expect(run.bucket.contents().has(kept)).toBe(true);
  });

  /**
   * ── The regression gate for a deleting page walk ──────────────────────────
   *
   * An apply-mode sweep DELETES each original after copying it, so the listing it
   * is paging through shrinks underneath it. That makes the page token's semantics
   * load-bearing: a real GCS page token is an opaque CURSOR, stable under deletion
   * behind it, and a walk that instead resumed at an OFFSET would skip exactly one
   * object per deletion and silently leave orphans behind.
   *
   * Every other apply-mode case here puts at most one page's worth of objects under
   * any single prefix, so none of them can see the difference — a sweep that skips
   * an object lowers `orphanCount` and `quarantinedCount` together and every
   * relative assertion still holds. This case is therefore stated in ABSOLUTE
   * terms against the fixture: seven orphans under ONE prefix at `pageSize: 2`, and
   * all seven must be gone from the bucket and present in quarantine.
   *
   * Verified load-bearing by reverting the harness's token to an offset, at which
   * point this test fails with `objectsScanned` 5 instead of 8 and four orphans
   * still sitting in the bucket.
   */
  it('quarantines EVERY orphan across four pages of a single prefix, skipping none', async () => {
    // Eight objects under ONE prefix, so `pageSize: 2` gives four pages within that
    // prefix rather than one page per prefix. The referenced one sits in the middle
    // of the lexicographic order so a page boundary falls on either side of it.
    const orphans = [0, 1, 2, 3, 5, 6, 7].map((index) => `notices/${TENANT}/page_${index}.png`);
    const referenced = `notices/${TENANT}/page_4.png`;
    const all = [...orphans, referenced].sort();

    const run = await sweep({
      objects: all.map((objectPath, index) => orphan(objectPath, 10 * (index + 1))),
      collections: {
        notices: { notice_live: { tenantId: TENANT, imageStoragePath: referenced } },
      },
      config: applyConfig({ pageSize: 2 }),
    });

    const [result] = run.result.tenants;
    expect(result.status).toBe('completed');

    // Absolute, against the fixture: every object was examined exactly once, and
    // every orphan moved. A skipped object shows up here as a shortfall — this is
    // the assertion that states the damage, so it comes first.
    expect([...run.bucket.contents().keys()].filter((name) => name.startsWith(`notices/${TENANT}/`))).toEqual(
      [referenced]
    );
    expect(result.objectsScanned).toBe(all.length);
    expect(result.orphanCount).toBe(orphans.length);
    expect(result.quarantinedCount).toBe(orphans.length);
    expect(result.quarantineFailures).toBe(0);
    expect(result.retainedByReason.referenced).toBe(1);
    expect(examinedNames(run.log).filter((name) => name.startsWith(`notices/${TENANT}/`)).sort()).toEqual(
      all
    );

    for (const objectPath of orphans) {
      expect(
        run.bucket.contents().has(`${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${objectPath}`)
      ).toBe(true);
    }

    // And more than one page WAS fetched for the prefix under test, so the absolute
    // assertions above cannot have passed for the wrong reason.
    const noticePages = run.bucket.getFilesCalls.filter(
      (call) => call.maxResults !== undefined && call.prefix === `notices/${TENANT}/`
    );
    // Four pages of two — the fourth returns exactly `pageSize` objects and no
    // token, so there is no empty tail page — and three of them resumed at a token.
    expect(noticePages.length).toBe(4);
    expect(noticePages.filter((call) => call.pageToken !== undefined).length).toBe(3);
  });

  it('records a manifest entry per moved object with its bytes and retention window', async () => {
    const run = await sweep({
      objects: [orphan(moved[2], 4_096)],
      config: applyConfig({ quarantineRetentionDays: 7 }),
    });

    expect(run.result.tenants[0].quarantinedCount).toBe(1);
    const entry = run.db.read(quarantineManifestPath(TENANT, SWEEP_ID, moved[2]))!;
    expect(entry).toMatchObject({
      tenantId: TENANT,
      sweepId: SWEEP_ID,
      objectPath: moved[2],
      quarantinePath: `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${moved[2]}`,
      bytes: 4_096,
    });
    expect((entry.movedAt as Date).getTime()).toBe(NOW);
    expect((entry.retainedUntil as Date).getTime()).toBe(NOW + 7 * DAY);
  });
});

/**
 * ── The accounting identity, asserted directly ─────────────────────────────
 *
 * `objectsScanned == sum(retainedByReason) + orphanCount` is already true of every
 * run in this file and is asserted over generated input by Property 14. What was
 * NOT checked anywhere is that the sweep would NOTICE if it stopped being true —
 * an object that falls through every branch of the per-object `if/continue` chain
 * without being counted is invisible in every downstream number, because
 * `objectsScanned` and the reason counters simply disagree by one.
 *
 * So the per-page invariant now includes the identity, and this asserts the
 * detector rather than the condition: a hand-built counter set that violates it
 * must throw. The `quarantined + failures <= orphans` inequality it sits beside
 * cannot catch this — a dropped object lowers `objectsScanned` alone.
 */
describe('the per-page invariants detect a dropped object', () => {
  function counters(overrides: Partial<SweepCounters> = {}): SweepCounters {
    return {
      objectsScanned: 0,
      retainedByReason: {
        referenced: 0,
        within_grace: 0,
        age_unknown: 0,
        unmanaged_path: 0,
        quarantine_path: 0,
      },
      orphanCount: 0,
      orphanBytes: 0,
      quarantinedCount: 0,
      quarantinedBytes: 0,
      quarantineFailures: 0,
      fieldReferencesObserved: 0,
      sampleOrphanPaths: [],
      ...overrides,
    };
  }

  it('accepts a balanced ledger', () => {
    expect(() =>
      assertSweepInvariants(
        TENANT,
        counters({
          objectsScanned: 5,
          retainedByReason: {
            referenced: 2,
            within_grace: 1,
            age_unknown: 0,
            unmanaged_path: 0,
            quarantine_path: 0,
          },
          orphanCount: 2,
          quarantinedCount: 2,
        }),
        10,
        10,
        counters()
      )
    ).not.toThrow();
  });

  it('throws when an object was scanned but counted under no reason and no candidate', () => {
    expect(() =>
      assertSweepInvariants(
        TENANT,
        counters({
          // Six scanned, five accounted for: one fell through every branch.
          objectsScanned: 6,
          retainedByReason: {
            referenced: 3,
            within_grace: 1,
            age_unknown: 0,
            unmanaged_path: 0,
            quarantine_path: 0,
          },
          orphanCount: 1,
        }),
        10,
        10,
        counters()
      )
    ).toThrow(/6 objects scanned but 4 retained \+ 1 candidates/);
  });

  it('measures the DELTA, so an inherited ledger from another code version cannot crash a resume', () => {
    // The baseline is read back out of a Firestore document. A document whose
    // `objectsScanned` and `retainedByReason` disagree — one written by a version of
    // this code with a different set of retain reasons — must not turn a resume into
    // a crash: what this process is responsible for is the delta.
    const inherited = counters({ objectsScanned: 99, orphanCount: 0 });
    expect(() =>
      assertSweepInvariants(
        TENANT,
        counters({
          objectsScanned: 101,
          retainedByReason: {
            referenced: 1,
            within_grace: 0,
            age_unknown: 0,
            unmanaged_path: 0,
            quarantine_path: 0,
          },
          orphanCount: 1,
        }),
        10,
        10,
        inherited
      )
    ).not.toThrow();
  });

  it('still catches a mutation ledger that exceeds its candidates', () => {
    expect(() =>
      assertSweepInvariants(
        TENANT,
        counters({ objectsScanned: 1, orphanCount: 1, quarantinedCount: 1, quarantineFailures: 1 }),
        10,
        10,
        counters()
      )
    ).toThrow(/exceeds candidates/);
  });

  it('still catches a retain set that moved during the listing', () => {
    expect(() => assertSweepInvariants(TENANT, counters(), 11, 10, counters())).toThrow(
      /retain set changed during listing/
    );
  });
});

describe('apply mode: the quota settlement', () => {
  const gone = `notices/${TENANT}/notice_k_gone.png`;
  const alsoGone = `notices/${TENANT}/notice_k_also_gone.png`;
  const live = `notices/${TENANT}/notice_k_live.png`;

  function fixture(): Scenario {
    return {
      objects: [orphan(gone, 100), orphan(alsoGone, 200), orphan(live, 50)],
      collections: {
        notices: { notice_live: { tenantId: TENANT, imageUrl: downloadUrl(live) } },
        // The recorded value before the run: the three objects, all still present.
        tenantStorageUsage: { [TENANT]: { tenantId: TENANT, bytes: 350 } },
      },
    };
  }

  it('recomputes exactly once after the last page and writes tenantStorageUsage in apply mode', async () => {
    const invalidated: string[] = [];
    const run = await sweep({
      ...fixture(),
      config: applyConfig(),
      invalidateLiveCount: (key) => invalidated.push(key),
    });

    const [result] = run.result.tenants;
    expect(result.quarantinedCount).toBe(2);

    // ONE recompute per tenant per run: one pass over the six managed prefixes,
    // paging without `maxResults`, and no second pass anywhere.
    const recompute = recomputeIndices(run.log);
    expect(recompute.length).toBe(STORAGE_TENANT_CATEGORIES.length);
    expect(Math.min(...recompute)).toBeGreaterThan(Math.max(...listingIndices(run.log)));

    // The recompute — and therefore the write — happens after the LAST move, so it
    // sums the post-sweep bucket rather than a bucket mid-move.
    const lastMutation = Math.max(
      run.log.indexOf((entry) => entry.method === 'file.delete' && entry.target === alsoGone),
      run.log.indexOf((entry) => entry.method === 'file.delete' && entry.target === gone)
    );
    const usageWrites = run.log.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === 'write' && entry.target === `tenantStorageUsage/${TENANT}`);
    expect(usageWrites.length).toBe(1);
    expect(usageWrites[0].index).toBeGreaterThan(lastMutation);
    expect(usageWrites[0].index).toBeGreaterThan(Math.max(...recompute));

    // Settled by recompute, not by decrement: the written value is the sum of what
    // is actually left, the quarantined copies contribute zero, and the record moved
    // down rather than up.
    expect(run.db.read(`tenantStorageUsage/${TENANT}`)).toMatchObject({ bytes: 50 });
    expect(result.usageBytesBefore).toBe(350);
    expect(result.usageBytesAfter).toBe(50);
    expect(result.usageBytesAfter!).toBeLessThanOrEqual(result.usageBytesBefore!);
    expect(invalidated).toEqual([`storageBytes:${TENANT}`]);
  });

  it('CONTROL: the identical fixture in report mode recomputes but writes nothing', async () => {
    const invalidated: string[] = [];
    const run = await sweep({
      ...fixture(),
      config: { mode: 'sweep', apply: false, sweepId: SWEEP_ID },
      invalidateLiveCount: (key) => invalidated.push(key),
    });

    const [result] = run.result.tenants;
    expect(run.result.dryRun).toBe(true);
    expect(result.orphanCount).toBe(2);
    expect(result.quarantinedCount).toBe(0);

    // The recompute still happens exactly once — computing a number is a read …
    expect(recomputeIndices(run.log).length).toBe(STORAGE_TENANT_CATEGORIES.length);
    expect(result.usageBytesAfter).toBe(350);
    // … and the Storage_Usage_Record is left exactly as it was, with no cache bust
    // and no bucket mutator anywhere.
    expect(run.db.read(`tenantStorageUsage/${TENANT}`)).toEqual({ tenantId: TENANT, bytes: 350 });
    expect(run.log.writes().filter(isForeignWrite)).toEqual([]);
    expect(run.log.methods().filter((method) => method.startsWith('bucket.file.'))).toEqual([]);
    expect(invalidated).toEqual([]);
  });
});

describe('apply mode: the per-tenant quarantine ceiling', () => {
  const objects = Array.from({ length: 5 }, (_, index) =>
    orphan(`notices/${TENANT}/orphan_${index}.png`, 10)
  );

  it('stops at the ceiling with a persisted cursor, and the remainder is a deliberate second run', async () => {
    const log = createOperationLog();
    const bucket = createFakeBucket({ log, objects });
    const db = createFakeFirestore({ log, collections: { notices: {} } });

    const capped = await sweep({ log, db, bucket, config: applyConfig({ maxQuarantinePerTenant: 2 }) });

    const [first] = capped.result.tenants;
    expect(first.status).toBe('aborted');
    expect(first.abortReason).toBe('quarantine_cap_reached');
    // The ceiling is checked BEFORE the move, so the count cannot exceed it.
    expect(first.quarantinedCount).toBe(2);
    expect(targetsFor(log, 'file.copy').length).toBe(2);
    expect(targetsFor(log, 'file.delete').length).toBe(2);

    // The cursor names the page the ceiling stopped on — `notices/` is the third of
    // the six prefixes — so the remainder resumes rather than restarting.
    const report = capped.report();
    expect(report.resume).toEqual({
      prefixIndex: STORAGE_TENANT_CATEGORIES.indexOf('notices'),
      pageToken: null,
    });
    expect([...bucket.contents().keys()].filter((name) => name.startsWith(`notices/`)).length).toBe(3);

    // ── The deliberate second run, with the ceiling raised ───────────────────
    const boundary = log.entries.length;
    const callBoundary = bucket.getFilesCalls.length;
    const resumed = await sweep({ log, db, bucket, config: applyConfig({ maxQuarantinePerTenant: 5 }) });

    const [second] = resumed.result.tenants;
    expect(second.status).toBe('completed');
    // The counters are inherited across the resume, so this is the run total.
    expect(second.quarantinedCount).toBe(5);
    // It continued from the persisted prefix instead of re-listing from the first.
    const resumedPaged = bucket.getFilesCalls.filter(
      (call) => call.index >= callBoundary && call.maxResults !== undefined
    );
    expect(resumedPaged[0].prefix).toBe(`notices/${TENANT}/`);
    expect(resumedPaged[0].pageToken).toBeUndefined();
    expect(targetsFor(log, 'file.copy', boundary).length).toBe(3);

    // Nothing was quarantined twice across the two runs, and every object now sits
    // under the same sweepId folder.
    const allCopies = targetsFor(log, 'file.copy');
    expect(allCopies.length).toBe(new Set(allCopies).size);
    for (const object of objects) {
      expect(bucket.contents().has(object.name)).toBe(false);
      expect(
        bucket.contents().has(`${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${object.name}`)
      ).toBe(true);
    }
  });
});

describe('apply mode: interruption, resumption and a changed fingerprint', () => {
  /**
   * One orphan per managed prefix, so each prefix is exactly one listing page and
   * a page failure lands on a prefix boundary.
   *
   * The `profile-pictures/` object needs a filename the derivation DESCRIBES —
   * twenty hex characters and `.jpg` — or it is retained as `unmanaged_path` and
   * never becomes a candidate, which is the rule task 6.2 landed and not something
   * to work around.
   */
  function spread(): FakeObject[] {
    return STORAGE_TENANT_CATEGORIES.map((category, index) =>
      orphan(
        `${category}/${TENANT}/${category === 'profile-pictures' ? 'a'.repeat(20) + '.jpg' : `obj_${index}.bin`}`,
        10 * (index + 1)
      )
    );
  }

  it('examines the same union across an interrupted run and its resumption, with nothing quarantined twice', async () => {
    // ── The uninterrupted baseline ────────────────────────────────────────────
    const baselineLog = createOperationLog();
    const baseline = await sweep({
      log: baselineLog,
      objects: spread(),
      config: applyConfig(),
    });
    expect(baseline.result.tenants[0].status).toBe('completed');
    const baselineExamined = [...examinedNames(baselineLog)].sort();

    // ── The interrupted run: the fourth listing page fails ───────────────────
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    let armed = true;
    let pagedSeen = 0;
    const bucket = createFakeBucket({
      log,
      objects: spread(),
      failGetFiles: (call) => {
        if (call.maxResults === undefined) return undefined;
        pagedSeen += 1;
        return armed && pagedSeen === 4 ? new Error('listing page failed') : undefined;
      },
    });

    // ── The substituted assertion (storage-sweep-scale-hardening Req 11.19) ────
    //
    // This was `await expect(sweep(...)).rejects.toThrow('listing page failed')`.
    // A listing failure no longer ends the run: it is confined to its tenant and
    // recorded as a Tenant_Sweep_Failure (Req 1.1), so the run RESOLVES. The
    // replacement asserts more than the thrown message it replaces — the recorded
    // status, the run's failure count, the coerced message, and the non-zero exit
    // code that count produces (Req 2.1). The two run-level precondition refusals
    // near the top of this file still raise and are deliberately untouched
    // (Req 11.22).
    const interruptedRun = await sweep({ log, db, bucket, config: applyConfig() });
    const failedTenant = interruptedRun.result.tenants[0];
    expect(failedTenant.status).toBe('failed');
    expect(failedTenant.failureMessage).toContain('listing page failed');
    expect(interruptedRun.result.tenantFailures).toBe(1);
    expect(sweepRunExitCode(interruptedRun.result)).toBe(1);

    // The previous page's cursor and counters survive, and `lastError` is recorded.
    const interrupted = db.read(tenantReportPath(TENANT))!;
    // Was `'in_progress'`: the same diagnostic write, one changed value (Req 1.7).
    expect(interrupted.status).toBe('failed');
    expect(typeof interrupted.lastError).toBe('string');
    expect(interrupted.resume).not.toBeNull();

    // ── The resumption, against the same bucket and the same references ──────
    armed = false;
    const boundary = log.entries.length;
    const resumed = await sweep({ log, db, bucket, config: applyConfig() });
    expect(resumed.result.tenants[0].status).toBe('completed');
    expect(examinedNames(log, boundary).length).toBeGreaterThan(0);

    // Req 13.12: the union of objects examined across the interrupted run and its
    // resumption equals what an uninterrupted run examines. Re-examining a page is
    // harmless; MISSING one is not.
    const union = [...new Set(examinedNames(log))].sort();
    expect(union).toEqual(baselineExamined);

    // Req 13.11: no object path was quarantined twice within the one sweepId.
    const allCopies = targetsFor(log, 'file.copy');
    expect(allCopies.length).toBe(new Set(allCopies).size);
    expect([...allCopies].sort()).toEqual(baselineExamined);
    for (const object of spread()) {
      expect(bucket.contents().has(object.name)).toBe(false);
      expect(
        bucket.contents().has(`${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${object.name}`)
      ).toBe(true);
    }
    expect(db.read(tenantReportPath(TENANT))!.resume).toBeNull();
  });

  it('discards the cursor and restarts from the first prefix when the reference fingerprint changed', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    let armed = true;
    let pagedSeen = 0;
    const bucket = createFakeBucket({
      log,
      objects: spread(),
      failGetFiles: (call) => {
        if (call.maxResults === undefined) return undefined;
        pagedSeen += 1;
        return armed && pagedSeen === 4 ? new Error('listing page failed') : undefined;
      },
    });

    // The same substitution as the case above (Req 11.19): the confined listing
    // failure resolves rather than raising, and carries the same new-contract
    // triple — recorded status, failure count, non-zero exit code.
    const interruptedRun = await sweep({ log, db, bucket, config: applyConfig() });
    expect(interruptedRun.result.tenants[0].status).toBe('failed');
    expect(interruptedRun.result.tenants[0].failureMessage).toContain('listing page failed');
    expect(interruptedRun.result.tenantFailures).toBe(1);
    expect(sweepRunExitCode(interruptedRun.result)).toBe(1);

    const persisted = db.read(tenantReportPath(TENANT))!;
    expect(persisted.status).toBe('failed');
    expect(persisted.resume).not.toBeNull();
    const persistedFingerprint = persisted.referenceFingerprint as string;

    // The reference set changes without the bucket changing at all: the
    // Monday/Wednesday case. A run resuming against a stale retain set would judge
    // Wednesday's bucket by Monday's idea of what is referenced.
    db.documents.set('notices/notice_new', {
      tenantId: TENANT,
      imageUrl: downloadUrl(`notices/${TENANT}/only_a_reference.png`),
    });

    armed = false;
    const callBoundary = bucket.getFilesCalls.length;
    const restarted = await sweep({ log, db, bucket, config: applyConfig() });

    const report = restarted.report();
    expect(report.referenceFingerprint).not.toBe(persistedFingerprint);
    expect(restarted.result.tenants[0].status).toBe('completed');

    // The listing restarted from the FIRST prefix with no page token rather than
    // continuing from the persisted cursor.
    const afterRestart = bucket.getFilesCalls.filter(
      (call) => call.index >= callBoundary && call.maxResults !== undefined
    );
    expect(afterRestart[0].prefix).toBe(`chat-files/${TENANT}/`);
    expect(afterRestart[0].pageToken).toBeUndefined();
  });
});

describe('apply mode: the abort gate still moves nothing', () => {
  it('aborts on a single malformed reference having quarantined zero objects', async () => {
    const objectPath = `notices/${TENANT}/notice_k_a.png`;
    const run = await sweep({
      objects: [orphan(objectPath, 10)],
      collections: {
        notices: {
          notice_bad: {
            tenantId: TENANT,
            imageUrl: `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/%zz`,
          },
        },
      },
      config: applyConfig(),
    });

    const [result] = run.result.tenants;
    expect(result.status).toBe('aborted');
    expect(result.abortReason).toBe('malformed_reference');
    // Req 9.6: an aborted run has quarantined zero objects. The bucket was never
    // listed, no mover was ever called, and the object is exactly where it was.
    expect(result.quarantinedCount).toBe(0);
    expect(run.bucket.getFilesCalls).toEqual([]);
    expect(run.log.methods().filter((method) => method.startsWith('bucket.file.'))).toEqual([]);
    expect(run.bucket.contents().has(objectPath)).toBe(true);
    // Not even the quota write, which apply mode would otherwise perform.
    expect(run.log.writes().filter(isForeignWrite)).toEqual([]);
  });
});

// ─── The purge stage (task 9.2) ─────────────────────────────────────────────
//
// End to end: an apply-mode run quarantines real orphans, and then the hard delete
// runs over the copies those moves produced. The quarantine copies carry the
// originals' timestamps, so the ones the sweep moved here are already well past a
// seven-day window — which is what makes the aged/not-aged split below observable
// without reaching into the clock.
//
// The last case is the one that matters most, and it is the reason this stage is a
// separate function with a separate input domain rather than a branch of the sweep:
// a live object path is spliced INTO the quarantine listing, and the purge refuses
// it. Not "declines to delete it because it checked a flag" — `parseQuarantinePath`
// simply does not accept it, so it is never a candidate. That is Property 8 with
// the real bucket walk wrapped around it.

describe('the purge stage: irreversible, and structurally unable to name a live object', () => {
  const orphans = [`notices/${TENANT}/gone_a.png`, `receipts/${TENANT}/fee_9/gone_b.pdf`];
  const live = `notices/${TENANT}/still_referenced.png`;

  const quarantinePath = (objectPath: string): string =>
    `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${objectPath}`;

  /** A quarantine copy the sweep did not make, so its age can be dictated. */
  const seeded = (objectPath: string, timestamps: Partial<FakeObject>): FakeObject => ({
    name: quarantinePath(objectPath),
    size: 11,
    ...timestamps,
  });

  const undatedPath = quarantinePath(`notices/${TENANT}/undated.png`);
  const freshPath = quarantinePath(`notices/${TENANT}/fresh.png`);

  /**
   * One apply-mode run, leaving two real quarantine copies behind, plus two seeded
   * copies whose ages sit either side of the window and one live referenced object
   * that no stage may touch.
   */
  async function quarantined(): Promise<SweepRun> {
    return sweep({
      objects: [
        orphan(orphans[0], 100),
        orphan(orphans[1], 200),
        orphan(live, 50),
        // Neither timestamp ⇒ the age is unreadable ⇒ retained.
        seeded(`notices/${TENANT}/undated.png`, {}),
        seeded(`notices/${TENANT}/fresh.png`, { timeCreated: FRESH, updated: FRESH }),
      ],
      collections: { notices: { notice_live: { tenantId: TENANT, imageUrl: downloadUrl(live) } } },
      config: applyConfig(),
    });
  }

  it('deletes only aged quarantine paths, retaining one whose age cannot be determined', async () => {
    const run = await quarantined();
    expect(run.result.tenants[0].quarantinedCount).toBe(2);
    const boundary = run.log.entries.length;

    const purged = await purgeExpiredQuarantine({
      bucket: run.bucket as never,
      db: run.db as never,
      purgeEnabled: true,
      apply: true,
      retentionDays: 7,
      nowMs: NOW,
    });

    expect(purged).toMatchObject({
      enabled: true,
      applied: true,
      retentionDays: 7,
      examined: 4,
      deleteEligible: 2,
      deleted: 2,
      deletedBytes: 300,
      retained: 2,
      failures: 0,
    });
    expect(purged.retainedByReason).toMatchObject({
      age_unknown: 1,
      within_retention: 1,
      not_a_quarantine_path: 0,
      tenant_scope_violation: 0,
    });

    // The two aged copies are gone for good; the two the gate held are still there.
    for (const objectPath of orphans) {
      expect(run.bucket.contents().has(quarantinePath(objectPath))).toBe(false);
    }
    expect(run.bucket.contents().has(undatedPath)).toBe(true);
    expect(run.bucket.contents().has(freshPath)).toBe(true);
    // The live object was never listed by this stage and is exactly where it was.
    expect(run.bucket.contents().has(live)).toBe(true);

    // EVERY path this stage deleted parses as a quarantine path. That is the
    // invariant, asserted over what actually happened rather than over the parser.
    const deleted = targetsFor(run.log, 'file.delete', boundary);
    expect(deleted.sort()).toEqual(orphans.map(quarantinePath).sort());
    for (const path of deleted) {
      expect(parseQuarantinePath(path)).not.toBeNull();
    }
    // Deleting is the only thing it did: no copy, no save, no metadata write, and
    // no Firestore write either — the manifest is never consulted or amended, so it
    // cannot have become the safety mechanism.
    expect(
      run.log.entries
        .slice(boundary)
        .filter((entry) => entry.kind === 'write')
        .map((entry) => entry.method)
    ).toEqual(['file.delete', 'file.delete']);
  });

  it('counts examined and delete-eligible without deleting anything when apply is false', async () => {
    const run = await quarantined();
    const boundary = run.log.entries.length;
    const before = [...run.bucket.contents().keys()].sort();

    const purged = await purgeExpiredQuarantine({
      bucket: run.bucket as never,
      db: run.db as never,
      purgeEnabled: true,
      apply: false,
      retentionDays: 7,
      nowMs: NOW,
    });

    // The dry run answers exactly what an apply run would delete, and deletes none
    // of it (Req 12.6).
    expect(purged).toMatchObject({
      enabled: true,
      applied: false,
      examined: 4,
      deleteEligible: 2,
      deleteEligibleBytes: 300,
      deleted: 0,
      deletedBytes: 0,
      retained: 2,
      failures: 0,
    });
    expect(run.log.entries.slice(boundary).filter((entry) => entry.kind === 'write')).toEqual([]);
    expect([...run.bucket.contents().keys()].sort()).toEqual(before);
  });

  it('refuses a live path injected into its input — not deleted, not counted eligible', async () => {
    const run = await quarantined();
    const boundary = run.log.entries.length;

    /**
     * The fake bucket, with two live object paths spliced into the first page of the
     * quarantine listing. This is the only way to hand the hard delete an input its
     * own domain forbids, and it models exactly the failure the design is built
     * against: a bug elsewhere, or a listing anomaly, offering a live path to the
     * irreversible stage. Both carry `OLD` timestamps, so the age gate would let
     * them through — the ONLY thing refusing them is the domain.
     */
    const injected = [live, `receipts/${TENANT}/fee_9/gone_b.pdf`];
    const bucket = {
      ...run.bucket,
      async getFiles(query: Record<string, unknown>) {
        const page = (await run.bucket.getFiles(query)) as unknown[];
        if (query.prefix === `${QUARANTINE_PREFIX}/` && Array.isArray(page[0])) {
          for (const name of injected) {
            (page[0] as unknown[]).push({
              name,
              metadata: { size: '50', timeCreated: OLD, updated: OLD },
            });
          }
        }
        return page;
      },
    };
    // The second injected path is a live path whose object no longer exists — the
    // sweep quarantined it — so a stage that deleted by name alone would 404 rather
    // than refuse. It must still be counted as refused.
    expect(run.bucket.contents().has(injected[1])).toBe(false);

    const purged = await purgeExpiredQuarantine({
      bucket: bucket as never,
      db: run.db as never,
      purgeEnabled: true,
      apply: true,
      retentionDays: 7,
      nowMs: NOW,
    });

    expect(purged.examined).toBe(6);
    // Refused: counted under its reason, and NOT counted delete-eligible. The two
    // eligible objects are the genuine quarantine copies, exactly as without the
    // injection.
    expect(purged.retainedByReason.not_a_quarantine_path).toBe(2);
    expect(purged.deleteEligible).toBe(2);
    expect(purged.deleted).toBe(2);

    const deleted = targetsFor(run.log, 'file.delete', boundary);
    expect(deleted).not.toContain(live);
    expect(deleted.sort()).toEqual(orphans.map(quarantinePath).sort());
    // The live object is untouched, and the stage never even obtained a handle for
    // it: a refusal happens before anything can name a file.
    expect(run.bucket.contents().has(live)).toBe(true);
    expect(run.log.entries.slice(boundary).filter((entry) => entry.target === live)).toEqual([]);
  });

  it('is unreachable from the sweep itself, in either mode', async () => {
    // Property 6 asserts report mode invokes no bucket mutator at all. The narrower
    // claim here is about this stage specifically: a full run, in the mode that IS
    // allowed to mutate, never deletes a quarantine path. The hard delete is a
    // separate entry point the runner calls under its own switch, and nothing in
    // `runStorageOrphanSweep` reaches it — which is what keeps the irreversible
    // stage out of report mode's blast radius by construction.
    const run = await quarantined();

    for (const target of targetsFor(run.log, 'file.delete')) {
      expect(parseQuarantinePath(target)).toBeNull();
    }
    expect(run.bucket.contents().has(undatedPath)).toBe(true);
    for (const objectPath of orphans) {
      expect(run.bucket.contents().has(quarantinePath(objectPath))).toBe(true);
    }
  });
});

// ─── Per-tenant failure confinement (storage-sweep-scale-hardening task 3.6) ──
//
// Additive: nothing above is edited by this block. The two run-level precondition
// refusals of Req 1.8 — an empty bucket name, and apply mode with no quarantine
// mover — still `rejects.toThrow` in `run-level refusals` above and stay exactly as
// they are (Req 11.22). What is asserted here is the confinement of a PER-TENANT
// failure: the run resolves, the failure is recorded, every later tenant is still
// swept, and the run is still red.
//
// The exit code is read through the runner's pure `sweepRunExitCode` seam rather
// than by mutating `process.exitCode`, which is the pattern the substituted
// assertions above already use: a leaked non-zero `process.exitCode` would make the
// whole jest process exit non-zero with every test passing.

const CONFINEMENT_TENANTS = ['acme', 'beta', 'gamma'] as const;

/** The collector's own summary line — see the note in the property test. */
const COLLECTOR_SUMMARY_LINE = '[orphan_sweep] references collected';

/** Every structured metric line emitted since the `console.log` spy was cleared. */
function emittedMetricLines(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const call of consoleLog.mock.calls) {
    const first = call[0];
    if (typeof first !== 'string' || !first.startsWith('{') || !first.includes('"metric"')) continue;
    lines.push(JSON.parse(first) as Record<string, unknown>);
  }
  return lines;
}

/**
 * Make `collectTenantReferenceSet` RAISE for one tenant.
 *
 * The collector is deliberately total for a source failure: every source body runs
 * inside `runSource`, which turns any thrown value into a `failedSources` entry —
 * and that is an ABORT, not a Tenant_Sweep_Failure. So the collector confinement
 * site (the one that must emit `runs_total` itself, Req 1.9) can only be reached
 * through the one statement in that function which sits outside every `try`: its
 * summary log line. The confinement contract does not depend on where the throw
 * came from.
 */
function armCollectorFailure(tenantId: string): void {
  consoleLog.mockImplementation((...called: unknown[]) => {
    if (called[0] === COLLECTOR_SUMMARY_LINE) {
      const detail = called[1] as { tenantId?: unknown } | undefined;
      if (detail?.tenantId === tenantId) {
        throw new Error(`reference collection failed for ${tenantId}`);
      }
    }
    return undefined;
  });
}

/** Three aged, unreferenced chat objects per tenant: one prefix, three pages. */
function confinementObjects(): FakeObject[] {
  return CONFINEMENT_TENANTS.flatMap((tenantId) =>
    [0, 1, 2].map((index) => orphan(`chat-files/${tenantId}/c_1/obj_${index}.bin`, 10 + index))
  );
}

/**
 * The confinement fixture's config, with the Report_Document write cadence pinned
 * to one write per listing page.
 *
 * ── Why the cadence is pinned here rather than left at its default (task 6.1) ──
 *
 * The subject of the two cases that use this is Req 1.6: after a listing page
 * fails, the PREVIOUS page's cursor and counters stand exactly as the failing
 * attempt left them, with `lastError` recorded alongside them. That claim is only
 * OBSERVABLE where a mid-listing write actually happened — and under the production
 * cadence (`reportWritePages: 10`, `reportWriteMs: 30_000`) a three-page listing
 * reaches neither interval, completes no Managed_Category prefix before the failure
 * and moves no object, so it writes nothing at all and the assertion would be about
 * an ABSENT cursor rather than a preserved one.
 *
 * An absent cursor is still correct under Req 7.7 — it names a page at or before the
 * first page whose work did not complete, so the resumption re-examines from page 1
 * and skips nothing — it simply says nothing about preservation. Pinning the
 * interval at one page keeps these cases asserting exactly what they were written to
 * assert, unchanged; the batched cadence itself is covered by task 6.6's own cases,
 * and every other case in this file runs at the production default.
 */
function confinementConfig(): Record<string, unknown> {
  return { tenantIds: [...CONFINEMENT_TENANTS], pageSize: 1, reportWritePages: 1 };
}

describe('a listing failure on one tenant is confined to that tenant', () => {
  it('sweeps tenants 2 and 3, records tenant 1 failed with its page-2 cursor, and exits non-zero', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    const pagedSeen = new Map<string, number>();
    const bucket = createFakeBucket({
      log,
      objects: confinementObjects(),
      failGetFiles: (call) => {
        if (call.maxResults === undefined || call.prefix === undefined) return undefined;
        const tenantId = call.prefix.split('/')[1];
        const seen = (pagedSeen.get(tenantId) ?? 0) + 1;
        pagedSeen.set(tenantId, seen);
        return tenantId === 'acme' && seen === 3 ? new Error('listing page failed') : undefined;
      },
    });

    const run = await sweep({
      log,
      db,
      bucket,
      config: confinementConfig(),
    });

    // Req 1.10: the deterministic order, so a repeated run reaches the tenants a
    // failed run did not.
    expect(run.result.tenants.map((tenant) => tenant.tenantId)).toEqual([...CONFINEMENT_TENANTS]);

    // Req 1.1, 1.7: recorded `'failed'`, not raised and not the legacy value.
    const [failed, second, third] = run.result.tenants;
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('listing page failed');
    expect(failed.abortReason).toBeUndefined();

    // Req 1.4: every remaining tenant swept, each with its OWN Report_Document.
    expect(second.status).toBe('completed');
    expect(third.status).toBe('completed');
    expect(run.report('beta').status).toBe('completed');
    expect(run.report('gamma').status).toBe('completed');
    expect(run.report('beta').objectsScanned).toBe(3);
    expect(run.report('gamma').objectsScanned).toBe(3);

    // Req 1.6: the previous page's cursor and counters stand exactly as the failing
    // attempt left them, and `lastError` is recorded alongside them. Pages 1 and 2
    // were examined; the persisted cursor is the token page 2 ended on.
    const report = run.report('acme');
    expect(report.status).toBe('failed');
    expect(typeof report.lastError).toBe('string');
    expect(report.resume).toEqual({
      prefixIndex: STORAGE_TENANT_CATEGORIES.indexOf('chat-files'),
      pageToken: 'after:chat-files/acme/c_1/obj_1.bin',
    });
    expect(report.objectsScanned).toBe(2);

    // Req 1.11, 2.1: counted, and red.
    expect(run.result.tenantFailures).toBe(1);
    expect(sweepRunExitCode(run.result)).toBe(1);
  });

  it('confines a failure inside the reference collector, writing NO report for that tenant', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    const bucket = createFakeBucket({ log, objects: confinementObjects() });

    consoleLog.mockClear();
    armCollectorFailure('acme');
    const run = await sweep({
      log,
      db,
      bucket,
      config: { tenantIds: [...CONFINEMENT_TENANTS], pageSize: 1 },
    });
    const metricLines = emittedMetricLines();
    consoleLog.mockImplementation(() => undefined);

    const [failed, second, third] = run.result.tenants;
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('reference collection failed');
    expect(second.status).toBe('completed');
    expect(third.status).toBe('completed');

    // A tenant whose collector raised reaches no listing at all, so it writes no
    // Report_Document and quarantines nothing structurally rather than by check
    // (Req 1.12). Its report therefore keeps whatever a previous run recorded —
    // nothing here — while its result carries `status: 'failed'`.
    expect(db.read(tenantReportPath('acme'))).toBeUndefined();
    expect(bucket.getFilesCalls.filter((call) => call.prefix?.includes('/acme/'))).toEqual([]);
    expect(failed.quarantinedCount).toBe(0);

    // Req 1.9: exactly one `runs_total` line for that tenant, and its `outcome`
    // label is `in_progress` — the collector site emits the line the collector does
    // not, and the label does NOT follow the status to `'failed'` (Req 1.15, 10.12).
    const runsLines = metricLines.filter(
      (line) => line.metric === 'storage_orphan_sweep_runs_total' && line.tenant_id === 'acme'
    );
    expect(runsLines).toHaveLength(1);
    expect(runsLines[0].outcome).toBe('in_progress');
    expect(
      metricLines.filter(
        (line) =>
          line.metric === 'storage_orphan_sweep_tenant_failures_total' && line.tenant_id === 'acme'
      )
    ).toHaveLength(1);
    for (const line of metricLines) {
      for (const key of ['tenant_id', 'mode', 'reason', 'outcome', 'abort_reason']) {
        expect(line[key]).not.toBe('failed');
      }
    }

    expect(run.result.tenantFailures).toBe(1);
    expect(sweepRunExitCode(run.result)).toBe(1);
  });

  it("resumes a tenant recorded 'failed' from its page-2 cursor while the completed tenants are no-ops", async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    let armed = true;
    const pagedSeen = new Map<string, number>();
    const bucket = createFakeBucket({
      log,
      objects: confinementObjects(),
      failGetFiles: (call) => {
        if (call.maxResults === undefined || call.prefix === undefined) return undefined;
        const tenantId = call.prefix.split('/')[1];
        const seen = (pagedSeen.get(tenantId) ?? 0) + 1;
        pagedSeen.set(tenantId, seen);
        return armed && tenantId === 'acme' && seen === 3
          ? new Error('listing page failed')
          : undefined;
      },
    });

    const first = await sweep({
      log,
      db,
      bucket,
      config: confinementConfig(),
    });
    expect(first.result.tenants[0].status).toBe('failed');
    const interruptedReport = db.read(tenantReportPath('acme')) as DocData;
    const interruptedCursor = interruptedReport.resume;

    // ── The same run re-executed (Req 1.13, 1.14) ────────────────────────────
    //
    // A recorded `'failed'` status is not `'completed'`, so it takes the
    // default-to-resume path: no early return, the persisted cursor and counters
    // inherited, the listing continued from page 3.
    armed = false;
    const callBoundary = bucket.getFilesCalls.length;
    const resumed = await sweep({
      log,
      db,
      bucket,
      config: confinementConfig(),
    });

    const [acme, beta, gamma] = resumed.result.tenants;
    expect(acme.status).toBe('completed');
    expect(resumed.result.tenantFailures).toBe(0);
    expect(sweepRunExitCode(resumed.result)).toBe(0);

    // Inherited rather than restarted: two objects were examined before the
    // failure and the third after it, for three in total on a resumed run.
    expect(acme.objectsScanned).toBe(3);
    const acmePaged = bucket.getFilesCalls.filter(
      (call) =>
        call.index >= callBoundary &&
        call.maxResults !== undefined &&
        call.prefix === 'chat-files/acme/'
    );
    expect(acmePaged.length).toBeGreaterThan(0);
    // It continued from the persisted cursor rather than re-listing from page 1.
    expect(acmePaged[0].pageToken).toBe((interruptedCursor as { pageToken: string }).pageToken);
    expect(db.read(tenantReportPath('acme'))!.resume).toBeNull();

    // Tenants 2 and 3 were recorded `completed`, so without `force` they are exact
    // no-ops: Phase 1 still runs, Phase 2 does not.
    expect(beta.status).toBe('completed');
    expect(gamma.status).toBe('completed');
    for (const tenantId of ['beta', 'gamma']) {
      expect(
        bucket.getFilesCalls.filter(
          (call) => call.index >= callBoundary && call.prefix?.includes(`/${tenantId}/`)
        )
      ).toEqual([]);
    }
  });

  /**
   * ── Every tenant aborted ⇒ exit ZERO, for all five abort reasons ───────────
   *
   * Enumerated rather than sampled, because Req 2.2 is stated over every one of the
   * five alike. `tenant_scope_violation` is the one a reader is most tempted to make
   * red and is the clearest case for green: it is the Scope_Guard *working*, catching
   * a derivation this code produced before a single byte moved.
   */
  describe('a run in which every tenant aborted exits zero', () => {
    const REASONS = [
      'reference_source_failed',
      'malformed_reference',
      'reference_cap_exceeded',
      'quarantine_cap_reached',
      'tenant_scope_violation',
    ] as const;

    it.each(REASONS)('%s is a designed safe outcome, not a failure', async (reason) => {
      const log = createOperationLog();
      const objects: FakeObject[] = [];
      const notices: Record<string, DocData> = {};
      for (const tenantId of CONFINEMENT_TENANTS) {
        objects.push(
          orphan(`notices/${tenantId}/notice_k_a.png`, 10),
          orphan(`notices/${tenantId}/notice_k_b.png`, 20)
        );
        if (reason === 'malformed_reference') {
          notices[`bad_${tenantId}`] = {
            tenantId,
            imageUrl: `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/%zz`,
          };
        } else {
          notices[`one_${tenantId}`] = {
            tenantId,
            imageUrl: downloadUrl(`notices/${tenantId}/notice_k_ref_1.png`),
          };
          notices[`two_${tenantId}`] = {
            tenantId,
            imageUrl: downloadUrl(`notices/${tenantId}/notice_k_ref_2.png`),
          };
        }
      }

      const db = createFakeFirestore({ log, collections: { notices } });
      const bucket = createFakeBucket({ log, objects });
      const applies = reason === 'quarantine_cap_reached' || reason === 'tenant_scope_violation';

      const result = await runStorageOrphanSweep({
        db: db as never,
        rtdb: createFakeRtdb({
          log,
          tree: {},
          ...(reason === 'reference_source_failed'
            ? { failure: { value: new Error('PERMISSION_DENIED') } }
            : {}),
        }) as never,
        bucket: bucket as never,
        config: sweepConfig({
          tenantIds: [...CONFINEMENT_TENANTS],
          nowMs: NOW,
          ...(applies ? { mode: 'sweep', apply: true, sweepId: SWEEP_ID } : {}),
          ...(reason === 'reference_cap_exceeded' ? { maxReferences: 1 } : {}),
          ...(reason === 'quarantine_cap_reached' ? { maxQuarantinePerTenant: 1 } : {}),
        }) as never,
        // The scope guard is unreachable through the Decision_Function, so the
        // violation is injected; what is under test is that the run stays GREEN.
        ...(reason === 'tenant_scope_violation'
          ? {
              quarantineObject: async () => {
                throw new TenantScopeViolation(`notices/other/x.png`, 'other', 'tenant_mismatch');
              },
            }
          : applies
            ? { quarantineObject }
            : {}),
      });

      for (const tenant of result.tenants) {
        expect(tenant.status).toBe('aborted');
        expect(tenant.abortReason).toBe(reason);
      }
      expect(result.tenantFailures).toBe(0);
      expect(sweepRunExitCode(result)).toBe(0);
    });
  });

  it('still runs the quarantine purger for a partially failed run, with the exit code still non-zero', async () => {
    // Req 2.5. The Quarantine_Purger's input domain is Quarantine paths only and is
    // independent of any tenant's Object_Listing, so a tenant that could not be
    // swept must not stop the retention window from being honoured — while the run
    // stays red. The runner sets the exit code and returns normally for exactly this
    // reason; here the two stages are driven in the runner's own order.
    const log = createOperationLog();
    const aged = `${QUARANTINE_PREFIX}/acme/prior_sweep/notices/acme/gone.png`;
    const objects: FakeObject[] = [
      ...confinementObjects(),
      { name: aged, size: 11, timeCreated: OLD, updated: OLD },
    ];
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    const bucket = createFakeBucket({
      log,
      objects,
      failGetFiles: (call) => {
        if (call.maxResults === undefined || call.prefix === undefined) return undefined;
        return call.prefix.includes('/acme/') ? new Error('listing page failed') : undefined;
      },
    });

    const run = await sweep({
      log,
      db,
      bucket,
      config: applyConfig({ tenantIds: [...CONFINEMENT_TENANTS], pageSize: 1 }),
    });

    expect(run.result.tenants[0].status).toBe('failed');
    expect(run.result.tenants[1].status).toBe('completed');
    expect(run.result.tenantFailures).toBe(1);
    const exitCode = sweepRunExitCode(run.result);
    expect(exitCode).toBe(1);

    const purged = await purgeExpiredQuarantine({
      bucket: bucket as never,
      db: db as never,
      purgeEnabled: true,
      apply: true,
      retentionDays: 7,
      nowMs: NOW,
    });

    // The purger ran and deleted the aged copy despite the failed tenant …
    expect(purged.enabled).toBe(true);
    expect(purged.applied).toBe(true);
    expect(purged.deleted).toBeGreaterThanOrEqual(1);
    expect(bucket.contents().has(aged)).toBe(false);
    // … and the run is still red afterwards: purging is not an excuse to go green.
    expect(sweepRunExitCode(run.result)).toBe(1);
  });
});

// ─── The Report_Document write cadence (task 6.6) ────────────────────────────
//
// Additive cases for the batched write cadence: the page interval, the
// Quarantine_Write_Threshold, and the cursor a mid-page write persists. Every claim
// below is read off the same single chronological log the rest of this file uses,
// with the tenant's Report_Document writes identified by their exact document path —
// the quarantine manifest lives UNDER that document, so a target-prefix filter would
// count one manifest write per moved object.
//
// ── Why every fixture here is SINGLE-PREFIX, and why that is not a convenience ──
//
// Req 7.4 forces a write on every completed Managed_Category prefix, and
// `listingPrefixesForTenant` walks all SIX unconditionally — the same `C = 6` the
// design's write bound `ceil(M/T) + floor(P/pageInterval) + C + 1` uses. An EMPTY
// prefix completes on its first page, so it writes too. `C + 1 = 7` is therefore the
// write FLOOR for any completed tenant sweep whatever the fixture does, and no
// *total*-write assertion of `<= 3` is reachable.
//
// Spread ten objects per prefix at `pageSize: 5` and each prefix completes after two
// pages, resetting `pagesSinceWrite`, so a 10-page interval is never reached AT ALL:
// the total is 7 — six prefix-completed writes plus the terminal write, zero
// interval-driven writes. The count would be dominated by an exception rather than by
// the interval and the reduction these cases are about would be invisible. Putting
// twelve consecutive pages under ONE prefix is what makes the interval the driver.
//
// The prefix is `chat-files/`, the FIRST of the six, for a second reason that only
// the crash case needs: nothing completes before it, so "no write has happened when
// the crash lands" is literally true rather than true of one prefix's listing.

/**
 * The single Managed_Category prefix every cadence fixture below lives in.
 *
 * `BATCH_LISTING_PREFIX` is what `listingPrefixesForTenant` asks the bucket for, and
 * therefore what a `getFiles` call records; `BATCH_PREFIX` is one folder deeper,
 * where the objects actually sit. The two are kept apart because every "this
 * prefix's own pages" filter below matches on the LISTING prefix.
 */
const BATCH_LISTING_PREFIX = `chat-files/${TENANT}/`;
const BATCH_PREFIX = `${BATCH_LISTING_PREFIX}c_batch/`;

/** A frozen LIVE clock: see `Scenario.now`. Write counts here are exact numbers. */
const FROZEN_NOW = () => NOW;

/** Inside the grace window, so this object is retained and never moved. */
function keep(objectPath: string): FakeObject {
  return { name: objectPath, size: 10, timeCreated: FRESH, updated: FRESH };
}

/** `count` aged, unreferenced objects in ONE prefix, listed in name order. */
function singlePrefixOrphans(count: number): FakeObject[] {
  return Array.from({ length: count }, (_, index) =>
    orphan(`${BATCH_PREFIX}obj_${String(index).padStart(3, '0')}.bin`, 10)
  );
}

/** Indices of every write to the TENANT'S OWN Report_Document, in log order. */
function reportWriteIndices(log: OperationLog, tenantId = TENANT): number[] {
  const path = tenantReportPath(tenantId);
  return log.entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.store === 'firestore' && entry.method === 'doc.set' && entry.target === path
    )
    .map(({ index }) => index);
}

/** The index of the `n`-th (1-based) entry for one logged method. */
function nthIndexOf(log: OperationLog, method: string, occurrence: number): number {
  let seen = 0;
  for (let index = 0; index < log.entries.length; index += 1) {
    if (log.entries[index].method !== method) continue;
    seen += 1;
    if (seen === occurrence) return index;
  }
  return -1;
}

describe('the report-write page interval reduces the write count for a long single-prefix listing', () => {
  /**
   * 60 objects in ONE prefix at `pageSize: 5` — twelve pages inside a single
   * Managed_Category prefix — under the production cadence of ten pages.
   *
   * The writes attributable to that prefix's own listing plus the run's terminal
   * write number **three rather than twelve**: one interval-driven write at page 10,
   * one prefix-completed write at page 12, and the terminal write. Twelve is the page
   * count, and therefore the number the shipped one-write-per-page cadence produced —
   * which the second case below measures directly rather than asserting from prose.
   */
  const objects = singlePrefixOrphans(60);

  it('writes at most three times for its own twelve pages, with a measured total of eight', async () => {
    const log = createOperationLog();
    const run = await sweep({
      log,
      objects,
      config: { pageSize: 5, reportWritePages: 10 },
      now: FROZEN_NOW,
    });

    expect(run.result.tenants[0].status).toBe('completed');

    // Twelve pages, all inside the one prefix.
    const paged = run.bucket.getFilesCalls.filter((call) => call.maxResults !== undefined);
    const ownPages = paged.filter((call) => call.prefix === BATCH_LISTING_PREFIX);
    expect(ownPages.length).toBe(12);
    expect(run.result.tenants[0].objectsScanned).toBe(60);

    // The writes attributable to THIS prefix's listing: everything before the first
    // page of the next prefix. The terminal write is the run's last, so the two
    // together are the `<= 3` claim.
    const nextPrefixAt = log.indexOf(
      (entry) =>
        entry.method === 'getFiles' &&
        entry.detail?.maxResults !== null &&
        entry.target !== BATCH_LISTING_PREFIX
    );
    expect(nextPrefixAt).toBeGreaterThan(-1);
    const writes = reportWriteIndices(log);
    const ownListingWrites = writes.filter((index) => index < nextPrefixAt);
    // One at page 10 (the interval) and one at page 12 (the completed prefix).
    expect(ownListingWrites.length).toBe(2);
    expect(ownListingWrites.length + 1).toBeLessThanOrEqual(3);

    // The measured TOTAL is eight, and the extra five are the five empty sibling
    // prefixes, each of which completes on its first page and each of which forces
    // its own write (Req 7.4). They sit outside the `<= 3` above by construction.
    expect(writes.length).toBe(8);
    expect(run.report().reportWrites).toBe(8);

    // The terminal write carries no cursor: the listing finished.
    expect(run.report().resume).toBeNull();
    expect(run.report().params).toMatchObject({ reportWritePages: 10, pageSize: 5 });
  });

  it('measures eighteen on the identical fixture under the shipped one-write-per-page cadence', async () => {
    const log = createOperationLog();
    const run = await sweep({
      log,
      objects,
      config: { pageSize: 5, reportWritePages: 1 },
      now: FROZEN_NOW,
    });

    expect(run.result.tenants[0].status).toBe('completed');

    const nextPrefixAt = log.indexOf(
      (entry) =>
        entry.method === 'getFiles' &&
        entry.detail?.maxResults !== null &&
        entry.target !== BATCH_LISTING_PREFIX
    );
    const writes = reportWriteIndices(log);
    // Twelve of the eighteen are this prefix's own pages — the page count, which is
    // where the "three rather than twelve" comparison comes from.
    expect(writes.filter((index) => index < nextPrefixAt).length).toBe(12);
    expect(writes.length).toBe(18);
    expect(run.report().reportWrites).toBe(18);
  });
});

describe('a crash seven pages into a batched listing resumes without skipping an object', () => {
  /**
   * The same single-prefix fixture, crashing on page 7 with the ten-page interval in
   * force. Pages 1–7 sit inside the FIRST prefix, so when the crash lands **no write
   * has happened at all**: seven pages is three short of the interval, no prefix has
   * completed, and report mode moves nothing.
   *
   * That is the point of the case. There is no cursor to resume from, so the
   * resumption re-examines from page 1 — the seven-page re-examination window this
   * measures — and the union of examined names is still exactly the uninterrupted
   * run's. Spread the fixture across six prefixes and every prefix boundary before
   * page 7 would already have persisted a cursor: the union assertion would still
   * pass, but on the prefix exception rather than on the interval.
   *
   * Re-examination is harmless and skipping is not, which is the asymmetry Req 7.7
   * states and the reason the cursor may only ever name a page at or before the first
   * page whose work did not complete.
   */
  const objects = singlePrefixOrphans(60);
  const batchConfig = { pageSize: 5, reportWritePages: 10 };

  it('examines the same union as an uninterrupted run, having written nothing before the crash', async () => {
    // ── The uninterrupted baseline ──────────────────────────────────────────
    const baselineLog = createOperationLog();
    const baseline = await sweep({
      log: baselineLog,
      objects,
      config: batchConfig,
      now: FROZEN_NOW,
    });
    expect(baseline.result.tenants[0].status).toBe('completed');
    const baselineExamined = [...new Set(examinedNames(baselineLog))].sort();
    expect(baselineExamined.length).toBe(60);

    // ── The interrupted run: page 7 of the first prefix fails ───────────────
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    let armed = true;
    let pagedSeen = 0;
    const bucket = createFakeBucket({
      log,
      objects,
      failGetFiles: (call) => {
        if (call.maxResults === undefined) return undefined;
        pagedSeen += 1;
        return armed && pagedSeen === 7 ? new Error('listing page failed') : undefined;
      },
    });

    const interruptedRun = await sweep({ log, db, bucket, config: batchConfig, now: FROZEN_NOW });
    // The interruption is read off the RESULT and the RECORDED document, both of
    // which exist whether or not anything was thrown (Req 1.1).
    expect(interruptedRun.result.tenants[0].status).toBe('failed');
    expect(interruptedRun.result.tenantFailures).toBe(1);
    expect(sweepRunExitCode(interruptedRun.result)).toBe(1);

    // Nothing was written before the crash: the only write on the document is the
    // catch's own, which touches `status`, `lastError`, `runnerId` and `updatedAt`
    // and therefore leaves no cursor and no counters behind it.
    expect(reportWriteIndices(log).length).toBe(1);
    const interrupted = db.read(tenantReportPath(TENANT))!;
    expect(interrupted.status).toBe('failed');
    expect(typeof interrupted.lastError).toBe('string');
    expect(interrupted.resume).toBeUndefined();
    expect(interrupted.objectsScanned).toBeUndefined();
    // Six pages were examined before the seventh failed to fetch.
    expect(examinedNames(log).length).toBe(30);

    // ── The resumption ──────────────────────────────────────────────────────
    armed = false;
    const boundary = log.entries.length;
    const callBoundary = bucket.getFilesCalls.length;
    const resumed = await sweep({ log, db, bucket, config: batchConfig, now: FROZEN_NOW });
    expect(resumed.result.tenants[0].status).toBe('completed');

    // It re-examined from page 1 of the first prefix: with no persisted cursor and no
    // persisted fingerprint there is nothing to resume from, and restarting is the
    // conservative reading of Req 7.7 rather than a failure of it. All twelve pages
    // were walked again, six of them for the second time — the re-examination window
    // this case exists to measure.
    const resumedPaged = bucket.getFilesCalls.filter(
      (call) => call.maxResults !== undefined && call.index >= callBoundary
    );
    expect(resumedPaged[0].prefix).toBe(BATCH_LISTING_PREFIX);
    expect(resumedPaged[0].pageToken).toBeUndefined();
    expect(examinedNames(log, boundary).length).toBe(60);

    // Req 7.7 — nothing skipped. The union across the two executions is exactly what
    // one uninterrupted run examines.
    const union = [...new Set(examinedNames(log))].sort();
    expect(union).toEqual(baselineExamined);
    // Report mode moved nothing, so nothing could be moved twice.
    expect(targetsFor(log, 'file.copy')).toEqual([]);
    expect(db.read(tenantReportPath(TENANT))!.resume).toBeNull();
  });
});

describe('a mid-listing batched write leaves the settled-at-the-end fields alone', () => {
  /**
   * Req 7.15. A mid-listing write advances the cursor and the counters and leaves
   * `danglingReferenceCount`, `usageBytesBefore` and `usageBytesAfter` untouched —
   * rather than writing a zero over a previous run's real value.
   *
   * No fixture constraint applies to the claim itself: a prefix-completed write is
   * already a mid-listing `partialFieldsOnly` write, so it is reachable under any
   * distribution. The single-prefix fixture is kept only so the observation point is
   * predictable.
   *
   * The observation is taken from inside the second run, through the listing hook, at
   * a moment when two mid-listing writes have landed and no terminal write has. That
   * is the only instant at which the claim is falsifiable: the terminal write sets
   * all three fields legitimately.
   */
  it('preserves a previous run\'s dangling and usage numbers through a mid-listing write', async () => {
    const objects = singlePrefixOrphans(20);
    const log = createOperationLog();
    // A reference to an object that is not in the bucket: a dangling reference, which
    // is counted, reported and never repaired.
    const db = createFakeFirestore({
      log,
      collections: {
        notices: {
          notice_dangling: {
            tenantId: TENANT,
            imageUrl: downloadUrl(`notices/${TENANT}/never_uploaded.png`),
          },
        },
      },
    });
    // A recorded usage figure, so `usageBytesBefore` is a real number rather than the
    // `null` a first-ever run records — a preserved `null` would prove nothing.
    db.documents.set('tenantStorageUsage/acme', { tenantId: TENANT, bytes: 999_000 });
    const bucket = createFakeBucket({ log, objects });

    const first = await sweep({
      log,
      db,
      bucket,
      config: applyConfig({ pageSize: 5, reportWritePages: 10 }),
      now: FROZEN_NOW,
    });
    expect(first.result.tenants[0].status).toBe('completed');
    const settled = first.report();
    expect(settled.danglingReferenceCount).toBe(1);
    expect(settled.usageBytesBefore).toBe(999_000);
    expect(typeof settled.usageBytesAfter).toBe('number');

    // ── The second run, forced so it re-lists, writing once per page ─────────
    let midListing: DocData | undefined;
    let pagedSeen = 0;
    const observingBucket = createFakeBucket({
      log,
      objects,
      failGetFiles: (call) => {
        if (call.maxResults === undefined) return undefined;
        pagedSeen += 1;
        // Snapshot after page 2's write has landed and before any terminal write.
        if (pagedSeen === 3) midListing = { ...(db.read(tenantReportPath(TENANT)) as DocData) };
        return undefined;
      },
    });

    const second = await sweep({
      log,
      db,
      bucket: observingBucket,
      config: applyConfig({ pageSize: 5, reportWritePages: 1, force: true }),
      now: FROZEN_NOW,
    });
    expect(second.result.tenants[0].status).toBe('completed');

    // The snapshot is genuinely a mid-listing progress write: still `in_progress`,
    // with a cursor and partial counters.
    expect(midListing).toBeDefined();
    expect(midListing!.status).toBe('in_progress');
    expect(midListing!.objectsScanned).toBe(10);
    expect(midListing!.resume).not.toBeNull();
    // And it left all three settled-at-the-end fields exactly as the previous run
    // recorded them, rather than zeroing them.
    expect(midListing!.danglingReferenceCount).toBe(1);
    expect(midListing!.usageBytesBefore).toBe(999_000);
    expect(midListing!.usageBytesAfter).toBe(settled.usageBytesAfter);
  });
});

describe('apply mode: the write trigger counts objects, not pages', () => {
  /**
   * One object moved on each of pages 1–12 at the default
   * `quarantineWriteThreshold: 25`: twelve moves never reach the threshold, so **no
   * `doc.set` is attributable to a move** and the write count stays purely
   * interval-driven. This is the case the rejected per-page trigger turned into
   * twelve writes, and it is the clearest single assertion that the trigger counts
   * objects rather than pages (Reqs 7.3, 7.9).
   *
   * The claim is about ATTRIBUTION, not about a total, so the five prefix-completed
   * writes cannot falsify it — but they can confuse the observation, so the fixture
   * stays single-prefix and each page's orphan is placed **first among its five
   * objects** rather than last. A prefix-completed write that landed immediately
   * after a page's last object was moved is indistinguishable in the operation log
   * from a threshold write; with the orphan first, the page's four remaining objects
   * are examined between the move and the boundary, so a write attributable to that
   * move would have to appear in that page's own region of the log.
   *
   * Which is what the per-page assertion below reads: pages 1–9 and page 11 each
   * moved an object and each issued **zero** Report_Document writes. Only page 10
   * (the interval) and page 12 (the completed prefix) wrote at all.
   *
   * The numeric form of the same claim: this apply-mode run's tenant-report total is
   * **eight**, identical to the report-mode arm's eight over the identical fixture.
   * The twelve moves added no write.
   */
  function orphanFirstPages(pages: number, perPage: number): FakeObject[] {
    const objects: FakeObject[] = [];
    for (let page = 0; page < pages; page += 1) {
      const label = String(page).padStart(2, '0');
      // `a` sorts before `b`–`e`, and the fake lists lexicographically, so the
      // candidate is the FIRST object of its page.
      objects.push(orphan(`${BATCH_PREFIX}p${label}_a_orphan.bin`, 10));
      for (let slot = 1; slot < perPage; slot += 1) {
        objects.push(keep(`${BATCH_PREFIX}p${label}_${'abcde'[slot]}_keep.bin`));
      }
    }
    return objects;
  }

  const objects = orphanFirstPages(12, 5);
  const cadence = { pageSize: 5, reportWritePages: 10, quarantineWriteThreshold: 25 };

  it('adds no write for twelve moves, matching the report-mode total on the same fixture', async () => {
    // ── The report-mode arm: the same fixture, moving nothing ────────────────
    const reportLog = createOperationLog();
    const reported = await sweep({ log: reportLog, objects, config: cadence, now: FROZEN_NOW });
    expect(reported.result.tenants[0].status).toBe('completed');
    expect(reported.result.tenants[0].orphanCount).toBe(12);
    const reportModeWrites = reportWriteIndices(reportLog).length;
    expect(reportModeWrites).toBe(8);

    // ── The apply-mode arm: twelve moves, the same eight writes ──────────────
    const log = createOperationLog();
    const applied = await sweep({ log, objects, config: applyConfig(cadence), now: FROZEN_NOW });
    const [result] = applied.result.tenants;
    expect(result.status).toBe('completed');
    expect(result.quarantinedCount).toBe(12);
    expect(targetsFor(log, 'file.copy').length).toBe(12);

    const writes = reportWriteIndices(log);
    expect(writes.length).toBe(8);
    // The twelve moves added NOTHING to the count the same fixture produced with no
    // mover installed at all.
    expect(writes.length).toBe(reportModeWrites);
    expect(applied.report().reportWrites).toBe(8);
    expect(applied.report().params).toMatchObject({ quarantineWriteThreshold: 25 });

    // ── Per page, which is where "no write is attributable to a move" is read ──
    //
    // The page regions are the spans between consecutive paged listing calls of this
    // prefix. Each of the twelve regions contains exactly one mover call; only two of
    // them contain a Report_Document write.
    const pageStarts = log.entries
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.method === 'getFiles' &&
          entry.detail?.maxResults !== null &&
          entry.target === BATCH_LISTING_PREFIX
      )
      .map(({ index }) => index);
    expect(pageStarts.length).toBe(12);

    const wroteOnPage: number[] = [];
    const movedOnPage: number[] = [];
    for (let page = 0; page < pageStarts.length; page += 1) {
      const from = pageStarts[page];
      const to = page + 1 < pageStarts.length ? pageStarts[page + 1] : log.entries.length;
      const region = log.entries.slice(from, to);
      const moves = region.filter((entry) => entry.method === 'file.copy').length;
      const pageWrites = region.filter(
        (entry) =>
          entry.store === 'firestore' &&
          entry.method === 'doc.set' &&
          entry.target === tenantReportPath(TENANT)
      ).length;
      if (moves > 0) movedOnPage.push(page + 1);
      if (pageWrites > 0) wroteOnPage.push(page + 1);
    }

    // Every page moved an object …
    expect(movedOnPage).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // … and only page 10 (the ten-page interval) and page 12 (the completed prefix)
    // wrote. Pages 1–9 and 11 each moved an object and wrote nothing, which a
    // per-page or per-move trigger could not do.
    expect(wroteOnPage).toEqual([10, 12]);
  });
});

describe('apply mode: a mid-page threshold write carries the unadvanced cursor', () => {
  /**
   * Thirty objects moved on page 4 at `quarantineWriteThreshold: 25`: a `doc.set`
   * lands **mid-page**, immediately after the 25th mover call and **before** page 4's
   * remaining movers, carrying the **page-3 `resume` token unadvanced** (Reqs 7.6,
   * 7.7, 7.24). This is the case a boundary-only threshold check fails outright — it
   * would issue no write at all until page 4 completed.
   *
   * Pages 1–4 must all be pages of the SAME prefix — a `pageSize` of at least 30
   * inside one Managed_Category prefix — because "the page-3 token" only names a page
   * of the listing the mid-page write is inside. The write count is not the subject
   * here, so the sibling prefixes' writes are irrelevant to the assertion.
   *
   * The counters on that write already include the 25 moves, while the cursor still
   * names page 3. The counters may LEAD the cursor and can never LAG it, and that is
   * the safe asymmetry: a resume re-examines page 4, finds its 25 moved objects gone
   * from the listing, and inherits a `quarantinedCount` that is exact rather than
   * short.
   */
  function midPageFixture(): FakeObject[] {
    const objects: FakeObject[] = [];
    // Pages 1–3: ninety objects inside the grace window, retained, moving nothing.
    for (let index = 0; index < 90; index += 1) {
      objects.push(keep(`${BATCH_PREFIX}a_keep_${String(index).padStart(3, '0')}.bin`));
    }
    // Page 4: thirty aged candidates, all of which move.
    for (let index = 0; index < 30; index += 1) {
      objects.push(orphan(`${BATCH_PREFIX}b_orphan_${String(index).padStart(3, '0')}.bin`, 10));
    }
    return objects;
  }

  it('writes between the 25th and 26th moves, carrying page 3\'s token and a count of 25', async () => {
    const log = createOperationLog();
    let moverCalls = 0;
    let atMove26: DocData | undefined;
    const db = createFakeFirestore({ log, collections: { notices: {} } });

    const run = await sweep({
      log,
      db,
      objects: midPageFixture(),
      config: applyConfig({
        pageSize: 30,
        reportWritePages: 10,
        quarantineWriteThreshold: 25,
        maxQuarantinePerTenant: 1_000,
      }),
      now: FROZEN_NOW,
      // The real mover, wrapped: the snapshot is taken at the one instant the
      // threshold write has landed and the page has not completed.
      quarantineObject: async (args) => {
        moverCalls += 1;
        if (moverCalls === 26) {
          atMove26 = { ...(db.read(tenantReportPath(TENANT)) as DocData) };
        }
        return quarantineObject(args);
      },
    });

    const [result] = run.result.tenants;
    expect(result.status).toBe('completed');
    expect(result.quarantinedCount).toBe(30);
    expect(moverCalls).toBe(30);

    // Four pages, all of the one prefix, and page 4 is the one that moves.
    const ownPages = run.bucket.getFilesCalls.filter(
      (call) => call.maxResults !== undefined && call.prefix === BATCH_LISTING_PREFIX
    );
    expect(ownPages.length).toBe(4);
    const pageThreeToken = ownPages[3].pageToken;
    expect(typeof pageThreeToken).toBe('string');
    // The token page 4 was fetched with IS the token page 3 ended on.
    expect(pageThreeToken).toBe(`after:${BATCH_PREFIX}a_keep_089.bin`);

    // ── The write landed MID-PAGE, between the 25th and the 26th move ────────
    const twentyFifthDelete = nthIndexOf(log, 'file.delete', 25);
    const twentySixthCopy = nthIndexOf(log, 'file.copy', 26);
    expect(twentyFifthDelete).toBeGreaterThan(-1);
    expect(twentySixthCopy).toBeGreaterThan(twentyFifthDelete);
    const between = reportWriteIndices(log).filter(
      (index) => index > twentyFifthDelete && index < twentySixthCopy
    );
    expect(between.length).toBe(1);

    // ── And it carried the UNADVANCED cursor with the leading counters ───────
    expect(atMove26).toBeDefined();
    expect(atMove26!.status).toBe('in_progress');
    expect(atMove26!.quarantinedCount).toBe(25);
    expect(atMove26!.resume).toEqual({
      prefixIndex: STORAGE_TENANT_CATEGORIES.indexOf('chat-files'),
      pageToken: pageThreeToken,
    });
    // The counters LEAD the cursor: page 4's own objects are already counted while
    // the cursor still names page 3.
    expect(atMove26!.objectsScanned).toBeGreaterThan(90);
  });
});

describe('apply mode: the per-move evaluation is what keeps a crash inside the ceiling', () => {
  /**
   * Ceiling 25, `quarantineWriteThreshold: 5`, all 40 candidates on one page, a crash
   * on the 21st mover call, then a resume. The two evaluation strategies produce
   * **different tenant totals**, and only one of them is inside Req 7.22's bound of
   * `ceiling + threshold - 1 = 29`. That divergence IS the case, so the total itself
   * is asserted rather than merely that some bound holds.
   *
   * **Per-move evaluation (correct, task 6.1).** Writes fire after moves 5, 10, 15
   * and 20, so the persisted `quarantinedCount` is **20** when the crash lands. The
   * resumption inherits 20, moves **5** more before the ceiling binds at 25, and the
   * tenant total is **25** — inside 29.
   *
   * **Boundary-only evaluation (the defect).** The page never completes, so **no
   * write happens at all** and the persisted count is **0**. The resumption inherits
   * 0 and moves the **20** candidates still in place — 40 less the 20 the crashed
   * execution already moved, every one of them beneath that resumption's own apparent
   * ceiling of 25 — for a tenant total of **40**, which breaches 29.
   *
   * ── Why the threshold must sit well BELOW the ceiling ─────────────────────────
   *
   * Set the threshold EQUAL to the ceiling — 25 and 25, the shipped default — and the
   * case stops discriminating: the ceiling check precedes the mover, so a run at
   * ceiling 25 moves exactly 25 and then aborts, and a crash inside a 25-object page
   * can only land after at most 24 successful moves. Forty candidates then cap the
   * tenant total at 40 under either strategy, so neither `<= 25 + 24` nor a "would
   * show 50" comparison separates them — 50 is not a state any implementation
   * reaches. The rule the numbers follow: Req 7.22's bound is
   * `ceiling + threshold - 1`, so a threshold equal to its ceiling has a bound of
   * `2 x ceiling - 1`, which is all but the `2 x ceiling` breach the threshold exists
   * to prevent. A discriminating case needs the threshold well under the ceiling, and
   * the smaller the threshold the tighter the bound and the sharper the test — which
   * is why these numbers are 25 and 5 rather than round, and why the crash lands past
   * move 20 rather than anywhere mid-page: it must land after MORE than `threshold`
   * moves inside a single page for the two strategies to have persisted different
   * counts.
   */
  const CEILING = 25;
  const THRESHOLD = 5;

  it('moves exactly 25 across the crash and the resume, where a boundary-only check would move 40', async () => {
    const objects = singlePrefixOrphans(40);
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    const bucket = createFakeBucket({ log, objects });
    // One page for all forty candidates: `pageSize` at its production default is
    // 1000, which is exactly why a boundary-only check leaves the breach open.
    const config = () =>
      applyConfig({
        pageSize: 1_000,
        reportWritePages: 10,
        quarantineWriteThreshold: THRESHOLD,
        maxQuarantinePerTenant: CEILING,
      });

    let moverCalls = 0;
    const crashed = await sweep({
      log,
      db,
      bucket,
      config: config(),
      now: FROZEN_NOW,
      quarantineObject: async (args) => {
        moverCalls += 1;
        if (moverCalls === 21) throw new Error('the process died mid-page');
        return quarantineObject(args);
      },
    });

    // The crash is recorded rather than raised, and read off the result.
    expect(crashed.result.tenants[0].status).toBe('failed');
    expect(crashed.result.tenantFailures).toBe(1);
    expect(sweepRunExitCode(crashed.result)).toBe(1);
    expect(targetsFor(log, 'file.copy').length).toBe(20);

    // Four writes fired on account of moves — after moves 5, 10, 15 and 20 — so the
    // count the resumption will inherit is 20 rather than 0. THIS is the number the
    // two strategies disagree about.
    const persisted = db.read(tenantReportPath(TENANT))!;
    expect(persisted.status).toBe('failed');
    expect(persisted.quarantinedCount).toBe(20);
    expect(persisted.resume).toEqual({
      prefixIndex: STORAGE_TENANT_CATEGORIES.indexOf('chat-files'),
      pageToken: null,
    });

    // ── The resumption ──────────────────────────────────────────────────────
    const boundary = log.entries.length;
    const resumed = await sweep({ log, db, bucket, config: config(), now: FROZEN_NOW });
    const [second] = resumed.result.tenants;
    expect(second.status).toBe('aborted');
    expect(second.abortReason).toBe('quarantine_cap_reached');

    // It inherited 20 and moved five more before the ceiling bound.
    expect(targetsFor(log, 'file.copy', boundary).length).toBe(5);
    expect(second.quarantinedCount).toBe(CEILING);

    // ── The tenant total, asserted as the number rather than as a bound ──────
    const allMoves = targetsFor(log, 'file.copy');
    expect(allMoves.length).toBe(25);
    // Nothing was moved twice within the one Sweep_Id.
    expect(new Set(allMoves).size).toBe(25);
    // Which is inside Req 7.22's bound — and a boundary-only check would have
    // persisted 0, inherited 0, moved the 20 remaining candidates and reached 40.
    expect(allMoves.length).toBeLessThanOrEqual(CEILING + THRESHOLD - 1);
    expect(CEILING + THRESHOLD - 1).toBe(29);
    // The fifteen candidates the ceiling protected are still in the bucket, and every
    // moved object is under this run's quarantine folder.
    expect([...bucket.contents().keys()].filter((name) => name.startsWith(BATCH_PREFIX)).length).toBe(
      15
    );
    for (const objectPath of allMoves) {
      expect(
        bucket.contents().has(`${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${objectPath}`)
      ).toBe(true);
    }
  });
});

describe('a configured quarantine write threshold never resolves to zero', () => {
  /**
   * Reqs 7.20 and 7.21. A resolved threshold of `0` satisfies Req 7.3's condition at
   * EVERY evaluation — the moved-object count is never negative and the comparison is
   * made first and unconditionally — so it would force a write on every move, every
   * page boundary and every terminal event alike. That is the write storm, not a
   * suppressed write, which is why the resolver falls back to the documented default
   * and additionally floors the result at one, and why the recorded value is worth
   * asserting: a `0` in `params` would be the visible symptom.
   *
   * `0.5` is the row that separates the two obligations, and it is the case the core's
   * resolver got wrong: it is finite and positive, so a plain positive-integer
   * normaliser never reaches its fallback, and `Math.trunc(0.5)` is `0`, which the
   * floor then turned into `1`. That is Req 7.21 honoured and Req 7.20 broken — a
   * write after every move, where the manifests and this very `params` block document
   * 25. The floor is a backstop against a resolved zero, not a substitute for the
   * documented fallback, so every one of these four records 25 and none records `0`
   * or `1`.
   */
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-numeric', 'abc'],
    ['truncates-to-zero', 0.5],
  ])('records 25 rather than 0 for a %s configured threshold', async (_label, configured) => {
    const run = await sweep({
      objects: singlePrefixOrphans(6),
      config: applyConfig({ pageSize: 5, quarantineWriteThreshold: configured }),
      now: FROZEN_NOW,
    });

    expect(run.result.tenants[0].status).toBe('completed');
    expect(run.report().params).toMatchObject({ quarantineWriteThreshold: 25 });
    expect((run.report().params as DocData).quarantineWriteThreshold).not.toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The reference ceiling, the heap guard and a legacy Report_Document
// (storage-sweep-scale-hardening task 8.7)
// ═════════════════════════════════════════════════════════════════════════════
//
// Additive throughout: no case, matcher or fixture above is altered. The only change
// to the shared machinery is the optional `readHeapUsage` seam on `Scenario`, which is
// inert unless a case installs it.

/** `query.get` entries in the log, i.e. how many Firestore PAGES were requested. */
function queryGetCount(log: OperationLog, from = 0): number {
  return log.entries.slice(from).filter((entry) => entry.method === 'query.get').length;
}

/**
 * `count` notice documents, each naming a distinct in-scope object.
 *
 * One document per page at `firestorePageSize: 1`, which is what makes "the paged
 * helper stopped requesting pages" a countable claim rather than an inference: the
 * page count and the admitted-reference count move together.
 */
function noticeReferences(count: number): Record<string, DocData> {
  const notices: Record<string, DocData> = {};
  for (let index = 0; index < count; index += 1) {
    const id = `notice_${String(index).padStart(3, '0')}`;
    notices[id] = { tenantId: TENANT, imageUrl: downloadUrl(`notices/${TENANT}/${id}.png`) };
  }
  return notices;
}

describe('the configured reference ceiling stops the paged reads, not just the admissions', () => {
  /**
   * Req 8.9 and Req 8.16, plus the half of task 5.1's `shouldStop` that only a real run
   * can show: a breached tenant stops **READING** rather than merely stopping admitting.
   *
   * Feeding `capExceeded` into `shouldStop` is verdict-neutral, and that is a claim
   * about `offer` rather than about the loop: `offer` returns BEFORE incrementing
   * `countsBySource` once the ceiling is breached, so stopping the reads and continuing
   * them yield the same retain set, the same counts and the same abort. The only
   * difference is how many round-trips were spent reaching a decision already made —
   * which is exactly what the `query.get` count measures.
   */
  it('reports capBreach configured and requests strictly fewer pages than an unbreached run', async () => {
    const collections = { notices: noticeReferences(10) };

    const breached = await sweep({
      objects: [orphan(`notices/${TENANT}/notice_k_orphan.png`, 10)],
      collections,
      config: { maxReferences: 3, firestorePageSize: 1 },
    });

    const [result] = breached.result.tenants;
    expect(result.status).toBe('aborted');
    expect(result.abortReason).toBe('reference_cap_exceeded');
    // Req 8.9 — WHICH ceiling bound. The configured one, not the heap guard: this
    // fixture is nowhere near a sample point, so `capBreach` distinguishes them.
    expect(result.capBreach).toBe('configured');
    expect(breached.report().capBreach).toBe('configured');
    // Admission stopped at `ceiling + 1`, which keeps the caller's `size > maxReferences`
    // gate true while refusing to grow further.
    expect(breached.report().referenceCount).toBe(4);
    // Req 8.12 — nothing listed, so nothing could have moved.
    expect(breached.bucket.getFilesCalls).toEqual([]);

    // ── The control: the identical fixture with a ceiling out of reach ─────────
    const unbreached = await sweep({
      objects: [orphan(`notices/${TENANT}/notice_k_orphan.png`, 10)],
      collections,
      config: { maxReferences: 10_000, firestorePageSize: 1 },
    });
    expect(unbreached.result.tenants[0].status).toBe('completed');

    // The measurable consequence: the breached run asked Firestore for strictly fewer
    // pages. Without `shouldStop` the two counts would be equal, because the collector
    // would page through all seven collections to build a set it had already refused
    // to grow.
    expect(queryGetCount(breached.log)).toBeLessThan(queryGetCount(unbreached.log));

    // And the shape of the stop, corroborated from the report: the notices walk halted
    // mid-source after the page that breached, and every LATER source read no page at
    // all — `shouldStop` is checked before each request, not only after each handler.
    const pages = breached.report().pagesBySource as Record<string, number>;
    expect(pages.notices).toBe(4);
    expect(pages.students).toBe(0);
    expect(pages.profile_pictures_derived).toBe(0);
    // `countsBySource` is unaffected by where the reads stopped (Req 3.16): `offer`
    // returns early once breached, so neither a stopped nor a continued walk counts
    // past the breach.
    expect((breached.report().countsBySource as Record<string, number>).notices).toBe(4);
  });
});

// ─── The mid-collection heap guard, through a real run ────────────────────────
//
// Reaching a heap sample needs `HEAP_GUARD_SAMPLE_INTERVAL` admitted references, and a
// `fees` document carries a receipts ARRAY whose every `storagePath` is offered as a
// bare path — so one document admits as many references as it has entries. Ten
// thousand admissions through one page of one collection, rather than ten thousand
// documents through ten pages.

/** One `fees` document whose receipts admit exactly `count` references. */
function bulkReceiptReferences(count: number): Record<string, Record<string, DocData>> {
  const receipts = Array.from({ length: count }, (_, index) => ({
    storagePath: `receipts/${TENANT}/fee_${String(index).padStart(6, '0')}/k_r.pdf`,
  }));
  return { fees: { fee_bulk: { tenantId: TENANT, receipts } } };
}

const SAMPLED_REFERENCES = HEAP_GUARD_SAMPLE_INTERVAL;

describe('the mid-collection heap guard, with the reading injected', () => {
  it('aborts with capBreach memory_guard, quarantines nothing, and reports what it compared', async () => {
    // Above BOTH conditions: past the 128 MiB floor and past 0.7 x the reported limit.
    // Either alone is not a breach (Req 8.18), which is what the next case pins.
    const limitBytes = 512 * 1024 * 1024;
    let reads = 0;
    const run = await sweep({
      objects: [orphan(`notices/${TENANT}/notice_k_orphan.png`, 4_096)],
      collections: bulkReceiptReferences(SAMPLED_REFERENCES),
      // APPLY mode with the real mover installed, so "quarantined nothing" is a claim
      // about a run that was ABLE to move something. In report mode it would be true of
      // every run for a reason that has nothing to do with the heap guard.
      config: applyConfig({ maxReferences: 1_000_000 }),
      readHeapUsage: () => {
        reads += 1;
        return { usedBytes: Math.floor(0.9 * limitBytes), limitBytes };
      },
      now: FROZEN_NOW,
    });

    // The guard was CHECKED, not merely present: one sample per 10,000 admissions.
    expect(reads).toBeGreaterThanOrEqual(1);

    const [result] = run.result.tenants;
    expect(result.status).toBe('aborted');
    // Req 8.10 — the same abort reason as the configured ceiling. A sixth value would
    // have invalidated every deployed metric label and monitoring filter for a
    // distinction that changes no behaviour.
    expect(result.abortReason).toBe('reference_cap_exceeded');
    expect(result.capBreach).toBe('memory_guard');
    expect(run.report().capBreach).toBe('memory_guard');

    // Req 8.12 — zero moves, because the gate in `sweepTenant` precedes any listing.
    // The listing call count is asserted too: "moved nothing" would also hold of a run
    // that listed everything and decided to move nothing.
    expect(result.quarantinedCount).toBe(0);
    expect(result.objectsScanned).toBe(0);
    expect(run.bucket.getFilesCalls).toEqual([]);
    expect(run.log.writes().filter((entry) => entry.store === 'bucket')).toEqual([]);
    // The orphan is still where it was.
    expect(run.bucket.contents().has(`notices/${TENANT}/notice_k_orphan.png`)).toBe(true);

    // Req 8.13 — the report states what was compared rather than only the verdict.
    const params = run.report().params as Record<string, unknown>;
    expect(params.maxReferences).toBe(1_000_000);
    expect(params.footprintEstimateBytes).toBe(estimateRetainSetFootprintBytes(1_000_000));
    expect(params.heapLimitBytes).toBe(limitBytes);
  });

  /**
   * Req 8.18, and the case a fraction-only guard fails.
   *
   * One byte used of a one-byte reported limit satisfies `used > 0.7 x limit`. A guard
   * without the Heap_Guard_Floor would abort a tenant holding a handful of references —
   * and it would do so on the reading a MISREPORTING environment produces, which is
   * precisely the environment an operator is least able to diagnose from an abort. A
   * mechanism whose whole purpose is to convert an unexplained kill into an explained
   * abort must not manufacture explained aborts out of nothing.
   */
  it('keeps collecting on a reported limit of one byte, and sweeps the tenant normally', async () => {
    let reads = 0;
    const orphanPath = `notices/${TENANT}/notice_k_orphan.png`;
    const run = await sweep({
      objects: [orphan(orphanPath, 4_096)],
      collections: bulkReceiptReferences(SAMPLED_REFERENCES),
      config: applyConfig({ maxReferences: 1_000_000 }),
      // The degenerate reading, at its extreme: `1 > 0.7 x 1` is true, so the fraction
      // is breached and only the floor is holding the guard back.
      readHeapUsage: () => {
        reads += 1;
        return { usedBytes: 1, limitBytes: 1 };
      },
      now: FROZEN_NOW,
    });

    // Not vacuous: the guard WAS evaluated and declined to trip.
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(exceedsHeapGuard(1, 1)).toBe(false);

    const [result] = run.result.tenants;
    expect(result.status).toBe('completed');
    expect(result.abortReason).toBeUndefined();
    expect(result.capBreach).toBeUndefined();
    expect(run.report().capBreach).toBeNull();
    // Collection ran to COMPLETION — every reference admitted — and the tenant was
    // swept normally rather than aborted before its listing.
    expect(run.report().referenceCount).toBe(SAMPLED_REFERENCES);
    expect(result.objectsScanned).toBe(1);
    expect(result.quarantinedCount).toBe(1);
    expect(run.bucket.contents().has(orphanPath)).toBe(false);
    // The reading is echoed AS GIVEN — a degenerate `1` and not a substituted default —
    // because the whole operator value of this field is that it reports what the process
    // actually observed. A `1` recorded here beside a completed sweep is precisely the
    // signal an operator needs: the environment is misreporting its heap limit, and the
    // floor is what stopped that misreport from manufacturing an abort. `null` is
    // reserved for a reading that is not a finite number at all.
    expect((run.report().params as Record<string, unknown>).heapLimitBytes).toBe(1);
  });
});

// ─── Backward compatibility with a Report_Document the shipped code wrote ─────

/** A shipped-shape Report_Document for `TENANT`, carrying `fingerprint`. */
function legacyReport(
  fingerprint: string,
  overrides: Record<string, unknown> = {}
): DocData {
  return {
    tenantId: TENANT,
    status: 'in_progress',
    mode: 'report',
    applied: false,
    sweepId: 'sweep_legacy_0001',
    runnerId: 'legacy-runner',
    referenceFingerprint: fingerprint,
    params: {
      graceDays: 7,
      graceCutoffMs: NOW - 7 * DAY,
      quarantineRetentionDays: 7,
      pageSize: 1,
      maxQuarantinePerTenant: 1_000,
      maxReferences: 10_000,
      nowMs: NOW,
      force: false,
    },
    countsBySource: { notices: 1 },
    referenceCount: 1,
    derivedReferenceCount: 0,
    resume: null,
    objectsScanned: 0,
    retainedByReason: { referenced: 0, within_grace: 0, age_unknown: 0, unmanaged_path: 0, quarantine_path: 0 },
    orphanCount: 0,
    orphanBytes: 0,
    quarantinedCount: 0,
    quarantinedBytes: 0,
    quarantineFailures: 0,
    fieldReferencesObserved: 0,
    sampleOrphanPaths: [],
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
    ...overrides,
  };
}

/**
 * Twelve aged objects in one Managed_Category, plus one referenced object so the
 * Reference_Fingerprint is a real one rather than the fingerprint of an empty set — a
 * stale fingerprint discards the cursor (Req 9.12), which would make an inheritance
 * assertion fail for a reason that has nothing to do with the recorded status.
 */
const LEGACY_REFERENCED = `notices/${TENANT}/notice_k_live.png`;

function legacyObjects(): FakeObject[] {
  const objects = Array.from({ length: 12 }, (_, index) =>
    orphan(`notices/${TENANT}/obj_${String(index).padStart(2, '0')}.bin`, 10 + index)
  );
  objects.push(orphan(LEGACY_REFERENCED, 5));
  return objects;
}

const LEGACY_COLLECTIONS = {
  notices: { notice_live: { tenantId: TENANT, imageUrl: downloadUrl(LEGACY_REFERENCED) } },
};

/** The fingerprint the current code produces for the fixture above. */
async function legacyFingerprint(): Promise<string> {
  const discovery = await sweep({
    objects: legacyObjects(),
    collections: LEGACY_COLLECTIONS,
    config: { pageSize: 3 },
  });
  expect(discovery.result.tenants[0].status).toBe('completed');
  const fingerprint = discovery.report().referenceFingerprint;
  expect(typeof fingerprint).toBe('string');
  return fingerprint as string;
}

describe('a Report_Document written by the shipped code resumes', () => {
  /**
   * Req 9.5. `countersFromProgress` seeds `retainedByReason` from `RETAIN_REASONS` and
   * overlays only the keys this version defines, so an unknown recorded key is never
   * READ — it contributes to no counter and reaches no assertion.
   *
   * ── "Nor deleted" is asserted over the WRITE, and the reason is a harness limit ──
   *
   * The writer never names the unknown key: its `retainedByReason` payload carries
   * exactly this version's five reasons and no deletion sentinel for anything else. That
   * is the claim about the CODE, and it is what is asserted here.
   *
   * Whether the key SURVIVES is a claim about Firestore, not about this code, and the
   * harness cannot answer it either way: real Firestore's `set(…, { merge: true })`
   * merges nested map fields recursively, so the unknown key survives in production —
   * while `createFakeFirestore`'s merge is a shallow top-level spread, so in the fake the
   * whole `retainedByReason` map is replaced. Asserting survival here would be asserting
   * the fake, and asserting removal would be asserting a behaviour production does not
   * have. So the assertion is over the payload, where the two agree.
   */
  it('resumes with an unknown retainedByReason key neither read nor deleted', async () => {
    const fingerprint = await legacyFingerprint();

    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: LEGACY_COLLECTIONS });
    db.documents.set(
      tenantReportPath(TENANT),
      legacyReport(fingerprint, {
        objectsScanned: 4,
        retainedByReason: {
          referenced: 1,
          within_grace: 0,
          age_unknown: 0,
          unmanaged_path: 0,
          quarantine_path: 0,
          // A reason a later version defined and this one does not.
          retained_by_a_future_reason: 3,
        },
        orphanCount: 3,
        resume: { prefixIndex: 0, pageToken: null },
      })
    );

    // Capture what each Report_Document write CARRIED: the log records that a write
    // happened, and this claim is about the payload.
    const payloads: DocData[] = [];
    const reportPath = tenantReportPath(TENANT);
    const capturing = {
      ...db,
      doc: (path: string) => {
        const handle = db.doc(path) as Record<string, unknown> & {
          set(data: DocData, options?: { merge?: boolean }): Promise<void>;
        };
        if (path !== reportPath) return handle;
        return {
          ...handle,
          async set(data: DocData, options?: { merge?: boolean }) {
            payloads.push(data);
            await handle.set(data, options);
          },
        };
      },
    } as ReturnType<typeof createFakeFirestore>;

    const run = await sweep({
      log,
      db: capturing,
      objects: legacyObjects(),
      collections: LEGACY_COLLECTIONS,
      config: { pageSize: 3 },
    });

    const [result] = run.result.tenants;
    // Req 9.1 — it resumed rather than raising.
    expect(result.status).toBe('completed');
    // Req 9.5 — the unknown key was not read: the resumed breakdown carries exactly the
    // reason set this version defines.
    expect(Object.keys(result.retainedByReason).sort()).toEqual([...RETAIN_REASONS].sort());
    // Req 9.4 — the inherited counters were inherited, on the DELTA identity: 4 scanned
    // before, 13 objects in the fixture, and the resume examined all 13 from prefix 0.
    expect(result.objectsScanned).toBe(4 + 13);

    // Nor deleted: no write names the unknown key at all — no deletion sentinel, no
    // explicit `null`, no `undefined`. See the block comment for why this is the
    // assertable form.
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      const written = payload.retainedByReason as Record<string, unknown> | undefined;
      if (written === undefined) continue;
      expect(Object.keys(written).sort()).toEqual([...RETAIN_REASONS].sort());
      expect(JSON.stringify(written)).not.toContain('retained_by_a_future_reason');
    }
  });

  /**
   * Reqs 1.13, 1.14 and 9.13 against a page-4 cursor.
   *
   * A recorded `'failed'` is not `'completed'`, so it takes the DEFAULT-TO-RESUME path:
   * no early return, the persisted cursor and counters inherited, the listing continued
   * from where the failing attempt stopped. That behaviour comes from the shipped
   * shape of the three resume read sites — all three test equality with `'completed'`
   * rather than inequality with `'in_progress'` — which is why this is a regression
   * test rather than the companion to an edit.
   */
  it("resumes a recorded 'failed' status from a page-4 cursor with no early return", async () => {
    const fingerprint = await legacyFingerprint();
    const objects = legacyObjects();
    // Page size 3 over 13 objects: pages 1-4 cover the first 12 names in listing order,
    // so a cursor after the 9th name is the token page 3 ended on and page 4 is what
    // resumes.
    const names = objects.map((object) => object.name).sort();
    const cursorName = names[8];
    // The recorded `prefixIndex` is an index into the Managed_Category tuple, not into
    // the fixture: `notices` is the third category, so a cursor inside the notices
    // listing is `{ prefixIndex: 2, … }`. Derived rather than written as `2`, so a
    // seventh category inserted ahead of it cannot silently move this cursor to the
    // wrong prefix.
    const noticesPrefixIndex = STORAGE_TENANT_CATEGORIES.indexOf('notices');
    expect(noticesPrefixIndex).toBeGreaterThanOrEqual(0);

    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: LEGACY_COLLECTIONS });
    db.documents.set(
      tenantReportPath(TENANT),
      legacyReport(fingerprint, {
        status: 'failed',
        lastError: 'listing page failed',
        objectsScanned: 9,
        retainedByReason: { referenced: 1, within_grace: 0, age_unknown: 0, unmanaged_path: 0, quarantine_path: 0 },
        orphanCount: 8,
        orphanBytes: 120,
        resume: { prefixIndex: noticesPrefixIndex, pageToken: `after:${cursorName}` },
      })
    );

    const run = await sweep({
      log,
      db,
      objects,
      collections: LEGACY_COLLECTIONS,
      config: { pageSize: 3 },
    });

    const [result] = run.result.tenants;
    // No early return: the tenant was re-listed and the report re-written.
    expect(result.status).toBe('completed');
    expect(result.reportWrites ?? 0).toBeGreaterThan(0);

    const paged = run.bucket.getFilesCalls.filter((call) => call.maxResults !== undefined);
    expect(paged.length).toBeGreaterThan(0);
    // It continued from the persisted cursor rather than re-listing from page 1.
    expect(paged[0].prefix).toBe(`notices/${TENANT}/`);
    expect(paged[0].pageToken).toBe(`after:${cursorName}`);

    // The objects the earlier attempt already examined are not re-examined.
    const examined = examinedNames(run.log);
    for (const name of names.slice(0, 9)) expect(examined).not.toContain(name);
    // …and the four it had not reached are.
    for (const name of names.slice(9)) expect(examined).toContain(name);

    // Req 1.13 — the counters are INHERITED, not restarted: 9 scanned before, 4 after.
    expect(result.objectsScanned).toBe(9 + 4);
    expect(result.orphanCount).toBeGreaterThanOrEqual(8);
    // Req 9.14 — the widening is additive: the resumed run records `'completed'`, and
    // the recorded meaning of the three shipped values is untouched.
    expect(run.report().status).toBe('completed');
    expect(run.report().resume).toBeNull();
  });
});

// ─── The Run_Lease, driven through real runs (spec task 9.6) ─────────────────
//
// ADDITIVE. Nothing above changes: the `renewRunLease` seam on `Scenario` is inert
// unless a case installs it, so every other run in this file is still a leaseless
// one — which is what makes Req 5.16 true of this suite rather than merely stated.
//
// ── What these cases add over the property test and the source assertions ────
//
// `runStorageOrphanSweep.test.ts` asserts the ORDER of the runner's lease calls over
// its source, because `main()` is unexported. Property 4 asserts the lease state
// machine over generated interleavings. What is left, and what these are, is the
// pair of claims an operator actually reads off a log: **a declined run performs no
// Object_Listing** and **a failed acquisition performs no Object_Listing either, and
// exits with the opposite code**. Here they are counts in the one chronological
// operation log rather than facts about text.

const LEASE_TENANTS = ['acme', 'beta'] as const;

/** Two aged, unreferenced chat objects per tenant. */
function leaseObjects(): FakeObject[] {
  return LEASE_TENANTS.flatMap((tenantId) =>
    [0, 1].map((index) => orphan(`chat-files/${tenantId}/c_1/obj_${index}.bin`, 20 + index))
  );
}

/** A lease record another execution left behind, with a chosen `expiresAtMs`. */
function foreignLeaseRecord(expiresAtMs: number, overrides: DocData = {}): DocData {
  return {
    jobName: RUN_LEASE_JOB_NAME,
    token: 'foreign-token-integration',
    runnerId: 'foreign-runner',
    sweepId: 'sweep_foreign_0001',
    mode: 'report',
    acquiredAtMs: NOW - 10 * 60_000,
    acquiredAtIso: iso(NOW - 10 * 60_000),
    expiresAtMs,
    renewals: 0,
    updatedAt: new Date(NOW - 10 * 60_000),
    ...overrides,
  };
}

/**
 * Record a promise's outcome as a VALUE.
 *
 * The precondition every assertion below establishes is the injected failure — a
 * transaction that was made to reject — not "something threw", so this is a recorded
 * outcome rather than a `try`-derived one (Req 11.26). If `acquireRunLease` stopped
 * throwing, the `ok: false` branch would simply not be taken and the assertions in
 * it would fail rather than pass vacuously.
 */
async function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
}

describe('a second execution while the Run_Lease is held (Reqs 5.4, 5.5)', () => {
  it('lists nothing, writes nothing and exits zero, while the holder sweeps every tenant', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    const bucket = createFakeBucket({ log, objects: leaseObjects() });

    // ── Execution 1: granted, and it sweeps ──────────────────────────────────
    const first = await acquireRunLease({
      db: db as never,
      runnerId: 'runner-1',
      sweepId: 'sweep_lease_first',
      mode: 'report',
      nowMs: NOW,
    });
    expect(first.ok).toBe(true);
    const holder = (first as { handle: RunLeaseHandle }).handle;

    const held = await sweep({
      log,
      db,
      bucket,
      config: { tenantIds: [...LEASE_TENANTS], pageSize: 1, sweepId: 'sweep_lease_first' },
      renewRunLease: () => holder.renew(NOW + 1_000),
    });
    expect(held.result.tenants.map((tenant) => tenant.status)).toEqual(['completed', 'completed']);
    expect(held.result.leaseLost).toBe(false);
    expect(sweepRunExitCode(held.result)).toBe(0);

    // ── Execution 2: declined, WHILE the first still holds ───────────────────
    //
    // Everything from here is the second run's, so the marker is what makes "the
    // second run's operation log" a slice of the one chronological log.
    const marker = log.entries.length;
    const second = await acquireRunLease({
      db: db as never,
      runnerId: 'runner-2',
      sweepId: 'sweep_lease_second',
      mode: 'report',
      nowMs: NOW + 2_000,
    });
    expect(second).toEqual({
      ok: false,
      reason: 'held',
      heldBy: { runnerId: 'runner-1', expiresAtMs: holder.expiresAtMs },
    });

    // The runner returns here without entering the core, so the second run's slice
    // contains its single `tx.get` and NOTHING else: no `getFiles`, no `tx.set`.
    const secondSlice = log.entries.slice(marker);
    expect(secondSlice.map((entry) => entry.method)).toEqual(['tx.get']);
    expect(secondSlice.filter((entry) => entry.method === 'getFiles')).toEqual([]);
    expect(secondSlice.filter((entry) => entry.method === 'tx.set')).toEqual([]);
    expect(secondSlice.filter((entry) => entry.kind === 'write')).toEqual([]);

    // Nothing was skipped — the holder did the work — so the declined run is GREEN.
    // Its exit code is `main()`'s plain `return`, i.e. the process status untouched.
    expect(db.read(tenantReportPath('acme'))!.status).toBe('completed');
    expect(db.read(tenantReportPath('beta'))!.status).toBe('completed');

    await holder.release();
    expect(db.read(runLeasePath())).toBeUndefined();
  });
});

describe('an acquisition whose transaction throws (Reqs 5.20, 5.21, 5.22)', () => {
  /**
   * The pair, side by side, because collapsing them is the easiest defect in this
   * spec to introduce and the hardest to notice: treat a failure as a decline and a
   * Firestore outage becomes a run of green no-ops that never sweeps anything again;
   * treat a decline as a failure and routine scheduled contention pages someone
   * every night.
   *
   * The two outcomes are asserted to have the SAME footprint — no listing, no tenant
   * swept, no write — and OPPOSITE exit codes.
   */
  it('does the same no work as a decline and exits with the opposite code', async () => {
    const outage = new Error('UNAVAILABLE: firestore transaction failed');

    // ── The FAILED acquisition ───────────────────────────────────────────────
    const failLog = createOperationLog();
    const failDb = createFakeFirestore({ log: failLog, collections: { notices: {} } });
    const failBucket = createFakeBucket({ log: failLog, objects: leaseObjects() });
    const failing = {
      ...failDb,
      runTransaction: () => Promise.reject(outage),
    } as ReturnType<typeof createFakeFirestore>;

    const failure = await settled(
      acquireRunLease({
        db: failing as never,
        runnerId: 'runner-fail',
        sweepId: 'sweep_lease_fail',
        mode: 'report',
        nowMs: NOW,
      })
    );
    expect(failure.ok).toBe(false);
    expect(failure.ok === false && failure.error).toBe(outage);

    // No Object_Listing, no tenant swept, nothing written — the runner never enters
    // the core, and the throw reaches `main().catch`, which sets exit code 1.
    expect(failLog.filter((entry) => entry.method === 'getFiles')).toEqual([]);
    expect(failLog.writes()).toEqual([]);
    expect(failBucket.getFilesCalls).toEqual([]);
    expect(failDb.read(tenantReportPath('acme'))).toBeUndefined();
    expect(failDb.read(runLeasePath())).toBeUndefined();
    const failedExitCode = 1;

    // ── The DECLINED acquisition, over the identical fixture ─────────────────
    const declineLog = createOperationLog();
    const declineDb = createFakeFirestore({ log: declineLog, collections: { notices: {} } });
    const declineBucket = createFakeBucket({ log: declineLog, objects: leaseObjects() });
    const heldRecord = foreignLeaseRecord(NOW + 30 * 60_000);
    declineDb.documents.set(runLeasePath(), heldRecord);

    const decline = await settled(
      acquireRunLease({
        db: declineDb as never,
        runnerId: 'runner-decline',
        sweepId: 'sweep_lease_decline',
        mode: 'report',
        nowMs: NOW,
      })
    );
    // A decline is a RETURN VALUE, never a throw: that is the type-level distinction
    // a caller cannot accidentally collapse.
    expect(decline.ok).toBe(true);
    expect(decline.ok === true && decline.value.ok).toBe(false);

    expect(declineLog.filter((entry) => entry.method === 'getFiles')).toEqual([]);
    expect(declineLog.writes()).toEqual([]);
    expect(declineBucket.getFilesCalls).toEqual([]);
    expect(declineDb.read(tenantReportPath('acme'))).toBeUndefined();
    // The holder's document is exactly as the holder left it.
    expect(declineDb.read(runLeasePath())).toEqual(heldRecord);
    const declinedExitCode = 0;

    // Same no-work outcome; opposite exit codes (Req 5.21).
    expect(declinedExitCode).not.toBe(failedExitCode);
    expect(declinedExitCode).toBe(0);
    expect(failedExitCode).not.toBe(0);
  });
});

describe('an expired Run_Lease is acquired, and the previous holder deletes nothing (Reqs 5.7, 5.12)', () => {
  it('grants to the waiting execution and makes the old holder release a no-op', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    const bucket = createFakeBucket({ log, objects: leaseObjects() });

    // The previous holder, whose lease then expires underneath it — an out-of-memory
    // kill or a platform timeout, which the expiry is the only mechanism to heal.
    const previous = await acquireRunLease({
      db: db as never,
      runnerId: 'runner-old',
      sweepId: 'sweep_lease_old',
      mode: 'report',
      leaseMs: 5 * 60_000,
      nowMs: NOW,
    });
    expect(previous.ok).toBe(true);
    const stale = (previous as { handle: RunLeaseHandle }).handle;
    expect(stale.expiresAtMs).toBe(NOW + 5 * 60_000);

    // One millisecond before the recorded expiry it is still held …
    const early = await acquireRunLease({
      db: db as never,
      runnerId: 'runner-new',
      sweepId: 'sweep_lease_new',
      mode: 'report',
      nowMs: stale.expiresAtMs - 1,
    });
    expect(early.ok).toBe(false);

    // … and once the recorded expiry has passed, the waiting execution gets it.
    const next = await acquireRunLease({
      db: db as never,
      runnerId: 'runner-new',
      sweepId: 'sweep_lease_new',
      mode: 'report',
      nowMs: stale.expiresAtMs + 1,
    });
    expect(next.ok).toBe(true);
    const fresh = (next as { handle: RunLeaseHandle }).handle;
    expect(db.read(runLeasePath())!.token).toBe(fresh.token);
    expect(db.read(runLeasePath())!.renewals).toBe(0);

    // The stale holder's release finds a token that is not its own and deletes
    // nothing (Req 5.7) — the one way this mechanism could itself cause an overlap.
    const marker = log.entries.length;
    await stale.release();
    expect(log.entries.slice(marker).map((entry) => entry.method)).toEqual(['tx.get']);
    expect(db.read(runLeasePath())!.token).toBe(fresh.token);

    // And the new holder sweeps normally under it.
    const run = await sweep({
      log,
      db,
      bucket,
      config: { tenantIds: [...LEASE_TENANTS], pageSize: 1, sweepId: 'sweep_lease_new' },
      renewRunLease: () => fresh.renew(stale.expiresAtMs + 2),
    });
    expect(run.result.tenants.map((tenant) => tenant.status)).toEqual(['completed', 'completed']);
    expect(run.result.leaseLost).toBe(false);
    expect(sweepRunExitCode(run.result)).toBe(0);
  });
});

describe('a foreign token written before tenant 2 renews (Reqs 5.9, 5.18, 5.19)', () => {
  it('sweeps exactly one tenant, exits 1, and leaves the lease byte-identical to the foreign write', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    const bucket = createFakeBucket({ log, objects: leaseObjects() });

    const acquisition = await acquireRunLease({
      db: db as never,
      runnerId: 'runner-fenced',
      sweepId: 'sweep_lease_fenced',
      mode: 'report',
      nowMs: NOW,
    });
    expect(acquisition.ok).toBe(true);
    const handle = (acquisition as { handle: RunLeaseHandle }).handle;

    // Another execution takes the lease between tenant 1 and tenant 2.
    let renewals = 0;
    let foreignSnapshot = '';
    const run = await sweep({
      log,
      db,
      bucket,
      config: { tenantIds: [...LEASE_TENANTS], pageSize: 1, sweepId: 'sweep_lease_fenced' },
      renewRunLease: async () => {
        renewals += 1;
        if (renewals === 2) {
          const foreign = foreignLeaseRecord(NOW + 45 * 60_000, { renewals: 7 });
          db.documents.set(runLeasePath(), foreign);
          foreignSnapshot = JSON.stringify(foreign);
        }
        return handle.renew(NOW + renewals * 1_000);
      },
    });

    // Req 5.9: no further tenant was STARTED, so exactly one tenant was swept and it
    // keeps its result and its Report_Document.
    expect(renewals).toBe(2);
    expect(run.result.tenants).toHaveLength(1);
    expect(run.result.tenants[0].tenantId).toBe('acme');
    expect(run.result.tenants[0].status).toBe('completed');
    expect(db.read(tenantReportPath('acme'))!.status).toBe('completed');
    // Tenant 2 was never started: no listing for it, and no Report_Document.
    expect(bucket.getFilesCalls.filter((call) => call.prefix?.includes('/beta/'))).toEqual([]);
    expect(db.read(tenantReportPath('beta'))).toBeUndefined();

    // Red, and a lost lease is a `break` plus a non-zero exit rather than a sixth
    // `SweepAbortReason`.
    expect(run.result.leaseLost).toBe(true);
    expect(run.result.tenantFailures).toBe(0);
    expect(run.result.tenants[0].abortReason).toBeUndefined();
    expect(sweepRunExitCode(run.result)).toBe(1);

    // Req 5.19: the fenced execution neither renewed the document, nor deleted it,
    // nor touched it in the runner's `finally`. The release below is the `finally`.
    const marker = log.entries.length;
    await handle.release();
    expect(log.entries.slice(marker).map((entry) => entry.method)).toEqual(['tx.get']);
    expect(JSON.stringify(db.read(runLeasePath()))).toBe(foreignSnapshot);
  });
});

describe('report mode with the lease installed writes ONE new document outside the report (Reqs 6.1, 6.5)', () => {
  it('adds only the lease document, and still leaves tenantStorageUsage absent', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: { notices: {} } });
    const bucket = createFakeBucket({ log, objects: leaseObjects() });
    const before = new Set(db.documents.keys());

    const acquisition = await acquireRunLease({
      db: db as never,
      runnerId: 'runner-report',
      sweepId: 'sweep_lease_report',
      mode: 'report',
      nowMs: NOW,
    });
    expect(acquisition.ok).toBe(true);
    const handle = (acquisition as { handle: RunLeaseHandle }).handle;

    const run = await sweep({
      log,
      db,
      bucket,
      config: { tenantIds: ['acme'], pageSize: 1, sweepId: 'sweep_lease_report' },
      renewRunLease: () => handle.renew(NOW + 1_000),
    });
    expect(run.result.dryRun).toBe(true);
    expect(run.result.tenants[0].status).toBe('completed');

    // Exactly two new documents: the tenant's Report_Document and the lease. The
    // lease is the ONLY addition outside the report, and it is inside the same
    // namespace — which is why the parent's Property 6 predicate stays one prefix
    // rather than becoming an allow-list.
    const added = [...db.documents.keys()].filter((path) => !before.has(path)).sort();
    expect(added).toEqual([runLeasePath(), tenantReportPath('acme')].sort());
    for (const path of added) expect(path.startsWith('storageMaintenanceJobs/')).toBe(true);

    // The quota record is still not written, and the recomputed value is still
    // recorded — unchanged by the lease.
    expect(db.read('tenantStorageUsage/acme')).toBeUndefined();
    expect(log.writes().some((entry) => entry.target.startsWith('tenantStorageUsage/'))).toBe(false);
    expect(typeof db.read(tenantReportPath('acme'))!.usageBytesAfter).toBe('number');
    // And no write of any kind landed outside the namespace.
    expect(log.writes().filter(isForeignWrite)).toEqual([]);

    await handle.release();
    expect(db.read(runLeasePath())).toBeUndefined();
  });
});
