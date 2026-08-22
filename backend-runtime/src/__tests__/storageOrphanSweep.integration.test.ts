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
} from '../lib/storageObjectRef';
import { buildTranscodeStoragePath } from '../videoTranscoder';
import {
  assertSweepInvariants,
  purgeExpiredQuarantine,
  quarantineManifestPath,
  quarantineObject,
  runStorageOrphanSweep,
  tenantReportPath,
  type SweepCounters,
} from '../jobs/storageOrphanSweep';
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
    ...(applyMode ? { quarantineObject } : {}),
    ...(scenario.invalidateLiveCount ? { invalidateLiveCount: scenario.invalidateLiveCount } : {}),
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

    await expect(sweep({ log, db, bucket, config: applyConfig() })).rejects.toThrow(
      'listing page failed'
    );

    // The previous page's cursor and counters survive, and `lastError` is recorded.
    const interrupted = db.read(tenantReportPath(TENANT))!;
    expect(interrupted.status).toBe('in_progress');
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

    await expect(sweep({ log, db, bucket, config: applyConfig() })).rejects.toThrow(
      'listing page failed'
    );
    const persisted = db.read(tenantReportPath(TENANT))!;
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
