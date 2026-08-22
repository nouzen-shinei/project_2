/**
 * Unit tests for Phase 1 of the storage orphan sweep — `collectTenantReferenceSet`
 * (spec `storage-orphan-cleanup`, task 5.6).
 *
 * Driven against in-memory Firestore and Realtime Database fakes rather than
 * mocks of the collector's own logic: the fakes answer `where('tenantId','==',t)`
 * queries and `orderByKey().startAfter().limitToFirst()` reads, and both record
 * every mutating method they expose so "Phase 1 writes nothing" is asserted over
 * the calls attempted, not inferred.
 *
 * The regression case this suite exists for is the last one: a chat attachment
 * referenced ONLY in the Realtime Database. `chat-files/{tenantId}/` is the
 * largest prefix in the bucket, so a collector that enumerated only Firestore
 * would return a retain set with no chat paths at all and every chat attachment
 * would become an orphan candidate.
 */

import {
  buildFirebaseDownloadUrl,
  classifyTenantScopedPath,
} from '../lib/storageObjectRef';
import { resolveUploadObjectPath } from '../lib/uploadObjectPath';
import {
  REFERENCE_SOURCE_IDS,
  collectTenantReferenceSet,
  type ReferenceSourceId,
  type TenantReferenceSet,
} from '../jobs/storageOrphanSweep';

const BUCKET = 'tution-app-6c0c3.firebasestorage.app';
const TENANT = 'acme';

/** A stored Firebase download URL for `objectPath`, as every url field holds. */
function url(objectPath: string, token = 'tok-1'): string {
  return buildFirebaseDownloadUrl(BUCKET, objectPath, token);
}

// ─── In-memory Firestore ─────────────────────────────────────────────────────

type DocData = Record<string, unknown>;
type FakeCollection = Record<string, DocData>;

function createFakeFirestore(options: {
  collections?: Record<string, FakeCollection>;
  /** Collection name → value thrown by every read of it. */
  failures?: Record<string, unknown>;
}) {
  const collections = options.collections ?? {};
  const failures = options.failures ?? {};
  const mutations: string[] = [];
  const reads: string[] = [];

  const failIfConfigured = (name: string): void => {
    if (Object.prototype.hasOwnProperty.call(failures, name)) {
      throw failures[name];
    }
  };

  const docSnapshot = (id: string, data: DocData | undefined) => ({
    id,
    exists: data !== undefined,
    data: () => data,
  });

  const querySnapshot = (entries: [string, DocData][]) => ({
    size: entries.length,
    empty: entries.length === 0,
    docs: entries.map(([id, data]) => docSnapshot(id, data)),
    forEach(callback: (doc: ReturnType<typeof docSnapshot>) => void) {
      for (const [id, data] of entries) callback(docSnapshot(id, data));
    },
  });

  const collection = (name: string) => {
    const filters: [string, string, unknown][] = [];
    const query: Record<string, unknown> = {
      where(field: string, operator: string, value: unknown) {
        filters.push([field, operator, value]);
        return query;
      },
      async get() {
        reads.push(`query:${name}`);
        failIfConfigured(name);
        const entries = Object.entries(collections[name] ?? {}).filter(([, data]) =>
          filters.every(([field, operator, value]) => operator === '==' && data?.[field] === value)
        );
        return querySnapshot(entries as [string, DocData][]);
      },
      doc(id: string) {
        return {
          async get() {
            reads.push(`doc:${name}/${id}`);
            failIfConfigured(name);
            return docSnapshot(id, (collections[name] ?? {})[id]);
          },
          set: async () => void mutations.push(`set ${name}/${id}`),
          update: async () => void mutations.push(`update ${name}/${id}`),
          create: async () => void mutations.push(`create ${name}/${id}`),
          delete: async () => void mutations.push(`delete ${name}/${id}`),
        };
      },
      add: async () => {
        mutations.push(`add ${name}`);
        return { id: 'generated' };
      },
    };
    return query;
  };

  const db = {
    collection,
    doc: (path: string) => ({
      get: async () => docSnapshot(path, undefined),
      set: async () => void mutations.push(`set ${path}`),
      update: async () => void mutations.push(`update ${path}`),
      delete: async () => void mutations.push(`delete ${path}`),
    }),
    batch: () => ({
      set: () => mutations.push('batch.set'),
      update: () => mutations.push('batch.update'),
      delete: () => mutations.push('batch.delete'),
      commit: async () => void mutations.push('batch.commit'),
    }),
    runTransaction: async () => {
      mutations.push('runTransaction');
    },
  };

  return { db, mutations, reads };
}

// ─── In-memory Realtime Database ─────────────────────────────────────────────

function createFakeRtdb(options: { tree?: Record<string, unknown>; failure?: unknown }) {
  const tree = options.tree ?? {};
  const mutations: string[] = [];
  const reads: string[] = [];
  const hasFailure = Object.prototype.hasOwnProperty.call(options, 'failure');

  const resolveNode = (segments: string[]): unknown => {
    let node: unknown = tree;
    for (const segment of segments) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return node;
  };

  const makeSnapshot = (entries: [string, unknown][], value: unknown) => ({
    exists: () => value !== null && value !== undefined,
    val: () => value,
    forEach(callback: (child: { key: string; val: () => unknown }) => boolean | void) {
      for (const [key, childValue] of entries) {
        if (callback({ key, val: () => childValue }) === true) return true;
      }
      return false;
    },
  });

  const makeQuery = (segments: string[], cursor: string | null, limit: number | null) => {
    const path = segments.join('/');
    const node: Record<string, unknown> = {
      orderByKey: () => makeQuery(segments, cursor, limit),
      startAfter: (value: string) => makeQuery(segments, String(value), limit),
      limitToFirst: (count: number) => makeQuery(segments, cursor, count),
      child: (key: string) => makeQuery([...segments, key], null, null),
      async get() {
        reads.push(`${path}${cursor === null ? '' : `>${cursor}`}${limit === null ? '' : `#${limit}`}`);
        if (hasFailure) throw options.failure;
        const target = resolveNode(segments);
        let entries: [string, unknown][] =
          target !== null && typeof target === 'object'
            ? Object.entries(target as Record<string, unknown>).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0
              )
            : [];
        if (cursor !== null) entries = entries.filter(([key]) => key > cursor);
        if (limit !== null) entries = entries.slice(0, limit);
        return makeSnapshot(entries, entries.length ? Object.fromEntries(entries) : target);
      },
      set: async () => void mutations.push(`set ${path}`),
      update: async () => void mutations.push(`update ${path}`),
      remove: async () => void mutations.push(`remove ${path}`),
      push: () => {
        mutations.push(`push ${path}`);
        return makeQuery([...segments, 'generated'], null, null);
      },
      transaction: async () => {
        mutations.push(`transaction ${path}`);
      },
    };
    return node;
  };

  const rtdb = {
    ref: (path: string) => makeQuery(String(path).split('/').filter(Boolean), null, null),
  };

  return { rtdb, mutations, reads };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Scenario {
  collections?: Record<string, FakeCollection>;
  tree?: Record<string, unknown>;
  firestoreFailures?: Record<string, unknown>;
  rtdbFailure?: { value: unknown };
  tenantId?: string;
  maxReferences?: number;
  conversationPageSize?: number;
  messagePageSize?: number;
}

async function collect(scenario: Scenario): Promise<{
  result: TenantReferenceSet;
  mutations: string[];
  rtdbReads: string[];
}> {
  const firestore = createFakeFirestore({
    collections: scenario.collections,
    failures: scenario.firestoreFailures,
  });
  const realtime = createFakeRtdb(
    scenario.rtdbFailure
      ? { tree: scenario.tree, failure: scenario.rtdbFailure.value }
      : { tree: scenario.tree }
  );

  const result = await collectTenantReferenceSet({
    db: firestore.db as never,
    rtdb: realtime.rtdb as never,
    tenantId: scenario.tenantId ?? TENANT,
    bucketName: BUCKET,
    maxReferences: scenario.maxReferences ?? 1_000,
    conversationPageSize: scenario.conversationPageSize,
    messagePageSize: scenario.messagePageSize,
  });

  return {
    result,
    mutations: [...firestore.mutations, ...realtime.mutations],
    rtdbReads: realtime.reads,
  };
}

/** `tenantChat/{t}/conversationMessages` tree for the given conversations. */
function chatTree(
  conversations: Record<string, Record<string, unknown>>,
  tenantId = TENANT
): Record<string, unknown> {
  return { tenantChat: { [tenantId]: { conversationMessages: conversations } } };
}

let consoleLog: jest.SpyInstance;

beforeAll(() => {
  // The collector logs one counts-only summary line per call; silence it so the
  // suite output stays readable.
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
});

// ─── Source 1: the RTDB chat walk ────────────────────────────────────────────

describe('collectTenantReferenceSet — source 1, RTDB chat messages', () => {
  it('collects a legacy single-file message from the message root', async () => {
    const photo = 'chat-files/acme/c_1/1712000000000_photo.jpg';
    const thumb = 'chat-files/acme/c_1/1712000000000_photo_thumb.jpg';
    const transcoded = 'chat-files/acme/c_1/1712000000000_clip_h264.mp4';

    const { result } = await collect({
      tree: chatTree({
        c_1: {
          '-msg_1': {
            sender: 'teacher@example.com',
            recipientId: 'student@example.com',
            fileUrl: url(photo),
            thumbnailUrl: url(thumb),
            // The transcoder's `rtdbAttachmentIndex === -1` write-back.
            transcodedUrl: url(transcoded),
          },
        },
      }),
    });

    expect(result.retainPaths.has(photo)).toBe(true);
    expect(result.retainPaths.has(thumb)).toBe(true);
    expect(result.retainPaths.has(transcoded)).toBe(true);
    expect(result.countsBySource.rtdb_chat_messages).toBe(3);
    expect(result.failedSources).toEqual([]);
    expect(result.abortReason).toBeNull();
  });

  it('collects a multi-file message from every attachment field', async () => {
    const first = 'chat-files/acme/c_2/k_aaaa_report.pdf';
    const firstThumb = 'chat-files/acme/c_2/k_aaaa_report_thumb.jpg';
    const clip = 'chat-files/acme/c_2/k_bbbb_clip.mov';
    const clipTranscoded = 'chat-files/acme/c_2/k_bbbb_clip_h264.mp4';

    const { result } = await collect({
      tree: chatTree({
        c_2: {
          '-msg_1': {
            sender: 'a@example.com',
            recipientId: 'b@example.com',
            attachments: [
              { url: url(first), thumbnailUrl: url(firstThumb) },
              { url: url(clip), transcodedUrl: url(clipTranscoded) },
            ],
          },
        },
      }),
    });

    for (const path of [first, firstThumb, clip, clipTranscoded]) {
      expect(result.retainPaths.has(path)).toBe(true);
    }
    expect(result.countsBySource.rtdb_chat_messages).toBe(4);
  });

  it('contributes nothing for a soft-deleted message', async () => {
    // `deleteChatMessage` nulls `fileUrl`, `thumbnailUrl` and `attachments` while
    // keeping the node. Its objects may survive a best-effort cleanup failure —
    // becoming candidates is the intended lifecycle-orphan outcome, not a gap.
    const { result } = await collect({
      tree: chatTree({
        c_3: {
          '-msg_1': {
            sender: 'a@example.com',
            recipientId: 'b@example.com',
            deleted: true,
            text: '',
            fileUrl: null,
            thumbnailUrl: null,
            attachments: null,
          },
        },
      }),
    });

    expect(result.countsBySource.rtdb_chat_messages).toBe(0);
    expect([...result.retainPaths].filter((path) => path.startsWith('chat-files/'))).toEqual([]);
    expect(result.malformedReferences).toBe(0);
    expect(result.failedSources).toEqual([]);
  });

  it('ignores external sticker and gif urls without recording a failure', async () => {
    const { result } = await collect({
      tree: chatTree({
        c_4: {
          '-msg_1': {
            sticker: { url: 'https://media.giphy.com/media/xyz/giphy.gif' },
            gif: { url: 'https://media.klipy.com/x.gif', thumbnailUrl: 'https://media.klipy.com/x.jpg' },
          },
        },
      }),
    });

    expect(result.countsBySource.rtdb_chat_messages).toBe(0);
    expect(result.malformedReferences).toBe(0);
    expect(result.failedSources).toEqual([]);
  });

  it('paginates both levels by key and misses no message', async () => {
    const conversations: Record<string, Record<string, unknown>> = {};
    const expected: string[] = [];
    for (let c = 1; c <= 3; c += 1) {
      const messages: Record<string, unknown> = {};
      for (let m = 1; m <= 3; m += 1) {
        const path = `chat-files/acme/c_${c}/k_${c}${m}_file.pdf`;
        expected.push(path);
        messages[`-msg_${m}`] = { fileUrl: url(path) };
      }
      conversations[`c_${c}`] = messages;
    }

    const { result, rtdbReads } = await collect({
      tree: chatTree(conversations),
      // One conversation and one message per page: a cursor that failed to
      // advance would loop or drop messages.
      conversationPageSize: 1,
      messagePageSize: 1,
    });

    for (const path of expected) expect(result.retainPaths.has(path)).toBe(true);
    expect(result.countsBySource.rtdb_chat_messages).toBe(9);
    // Level 2 really is a separate read per conversation page.
    expect(rtdbReads.some((read) => read.includes('/c_1#1'))).toBe(true);
    expect(rtdbReads.some((read) => read.includes('>-msg_1'))).toBe(true);
  });
});

// ─── Source 2: videoTranscodes ───────────────────────────────────────────────

describe('collectTenantReferenceSet — source 2, videoTranscodes', () => {
  const doneOutput = 'chat-files/acme/c_9/k_done_clip_h264.mp4';
  const doneOriginal = 'chat-files/acme/c_9/k_done_clip.mov';
  const processingOriginal = 'chat-files/acme/c_9/k_proc_clip.mov';
  const errorOutput = 'chat-files/acme/c_9/k_err_clip_h264.mp4';
  const skippedOriginal = 'chat-files/acme/c_9/k_skip_clip.mp4';

  it('applies the full status matrix', async () => {
    const { result } = await collect({
      collections: {
        videoTranscodes: {
          done: {
            tenantId: TENANT,
            status: 'done',
            originalDeleted: true,
            originalPath: doneOriginal,
            originalUrl: url(doneOriginal),
            transcodedPath: doneOutput,
            transcodedUrl: url(doneOutput),
          },
          processing: {
            tenantId: TENANT,
            status: 'processing',
            // Contradictory on purpose: `processing` retains the original
            // unconditionally, because ffmpeg may be reading it right now.
            originalDeleted: true,
            originalPath: processingOriginal,
          },
          errored: {
            tenantId: TENANT,
            status: 'error',
            // `/video/request-transcode` returns a `transcodedUrl` regardless of
            // status, so `status` is not a liveness signal.
            transcodedUrl: url(errorOutput),
          },
          skipped: {
            tenantId: TENANT,
            status: 'skipped',
            originalPath: skippedOriginal,
          },
          otherTenant: {
            tenantId: 'other',
            status: 'done',
            transcodedPath: 'chat-files/other/c_1/k_x_h264.mp4',
          },
        },
      },
    });

    expect(result.retainPaths.has(doneOutput)).toBe(true);
    expect(result.retainPaths.has(errorOutput)).toBe(true);
    expect(result.retainPaths.has(processingOriginal)).toBe(true);
    expect(result.retainPaths.has(skippedOriginal)).toBe(true);
    // `originalDeleted: true` with a settled status: the original's absence is
    // expected, so nothing needs retaining.
    expect(result.retainPaths.has(doneOriginal)).toBe(false);
    // Another tenant's document is not in this tenant's query at all.
    expect(result.retainPaths.has('chat-files/other/c_1/k_x_h264.mp4')).toBe(false);
    expect(result.failedSources).toEqual([]);
  });

  it('derives the _h264.mp4 output for a chat video with no videoTranscodes document', async () => {
    const original = 'chat-files/acme/c_5/k_cccc_clip.mov';

    const { result } = await collect({
      tree: chatTree({ c_5: { '-msg_1': { fileUrl: url(original) } } }),
    });

    expect(result.retainPaths.has(original)).toBe(true);
    expect(result.retainPaths.has('chat-files/acme/c_5/k_cccc_clip_h264.mp4')).toBe(true);
    expect(result.countsBySource.video_transcodes).toBe(1);
  });

  it('does not derive an output for a non-video chat object or for an existing output', async () => {
    const image = 'chat-files/acme/c_6/k_dddd_photo.jpg';
    const output = 'chat-files/acme/c_6/k_eeee_clip_h264.mp4';

    const { result } = await collect({
      tree: chatTree({ c_6: { '-msg_1': { fileUrl: url(image), transcodedUrl: url(output) } } }),
    });

    expect(result.retainPaths.has('chat-files/acme/c_6/k_dddd_photo_h264.mp4')).toBe(false);
    expect(result.retainPaths.has('chat-files/acme/c_6/k_eeee_clip_h264_h264.mp4')).toBe(false);
    expect(result.countsBySource.video_transcodes).toBe(0);
  });
});

// ─── Sources 3–7 ─────────────────────────────────────────────────────────────

describe('collectTenantReferenceSet — source 3, sharedFiles', () => {
  it('collects file.url and file.thumbnailUrl as an independent proof', async () => {
    const shared = 'chat-files/acme/c_7/k_ffff_deck.pdf';
    const thumb = 'chat-files/acme/c_7/k_ffff_deck_thumb.jpg';

    const { result } = await collect({
      collections: {
        sharedFiles: {
          tok_1: { tenantId: TENANT, file: { url: url(shared), thumbnailUrl: url(thumb) } },
          tok_other: { tenantId: 'other', file: { url: url('chat-files/other/c_1/x.pdf') } },
        },
      },
    });

    expect(result.retainPaths.has(shared)).toBe(true);
    expect(result.retainPaths.has(thumb)).toBe(true);
    expect(result.countsBySource.shared_files).toBe(2);
  });
});

describe('collectTenantReferenceSet — source 4, fees receipts array', () => {
  it('reads the receipts ARRAY and the singular legacy field', async () => {
    const first = 'receipts/acme/fee_1/k_1111_march.pdf';
    const second = 'receipts/acme/fee_1/k_2222_april.pdf';
    const legacy = 'receipts/acme/fee_2/1712000000000_may.pdf';

    const { result } = await collect({
      collections: {
        fees: {
          fee_1: {
            tenantId: TENANT,
            receipts: [
              { url: url(first), fileName: 'march.pdf', uploadedAt: '2026-03-01T00:00:00Z' },
              { url: url(second), fileName: 'april.pdf' },
            ],
          },
          fee_2: { tenantId: TENANT, receiptUrl: url(legacy) },
        },
      },
    });

    expect(result.retainPaths.has(first)).toBe(true);
    expect(result.retainPaths.has(second)).toBe(true);
    expect(result.retainPaths.has(legacy)).toBe(true);
    expect(result.countsBySource.fees).toBe(3);
  });

  it('skips all three malformed receipt shapes and keeps enumerating the source', async () => {
    const survivor = 'receipts/acme/fee_9/k_9999_survivor.pdf';

    const { result } = await collect({
      collections: {
        fees: {
          // 1. `receipts` is not an array.
          fee_a: { tenantId: TENANT, receipts: { '0': { url: url('receipts/acme/fee_a/x.pdf') } } },
          // 2. an entry is not an object.
          fee_b: { tenantId: TENANT, receipts: ['receipts/acme/fee_b/x.pdf', null, 7] },
          // 3. an entry's `url` is not a string.
          fee_c: { tenantId: TENANT, receipts: [{ url: 42 }, { url: null }, { fileName: 'no-url.pdf' }] },
          // The source must still reach this document.
          fee_d: { tenantId: TENANT, receipts: [{ url: url(survivor) }] },
        },
      },
    });

    expect(result.retainPaths.has(survivor)).toBe(true);
    expect(result.countsBySource.fees).toBe(1);
    // A stray shape is skipped, never counted as a malformed reference — which
    // would abort the tenant.
    expect(result.malformedReferences).toBe(0);
    expect(result.abortReason).toBeNull();
    expect(result.failedSources).toEqual([]);
  });

  it('also reads a receipt entry storagePath, which useFees deletes by', async () => {
    const path = 'receipts/acme/fee_3/k_3333_june.pdf';

    const { result } = await collect({
      collections: {
        fees: { fee_3: { tenantId: TENANT, receipts: [{ storagePath: path }] } },
      },
    });

    expect(result.retainPaths.has(path)).toBe(true);
  });
});

describe('collectTenantReferenceSet — source 5, notices', () => {
  it('reads a notice with imageStoragePath and one without', async () => {
    const withPathImage = 'notices/acme/notice_k_1111.png';
    const withPathAudio = 'notices/acme/audio/notice_audio_k_1111.m4a';
    const withoutPathImage = 'notices/acme/notice_k_2222.png';

    const { result } = await collect({
      collections: {
        notices: {
          // `imageStoragePath` is absent from `types/notice.ts` but is read by
          // `app.ts`'s notice-delete handler, so it exists on some documents.
          notice_a: {
            tenantId: TENANT,
            imageStoragePath: withPathImage,
            audioStoragePath: withPathAudio,
            linkUrl: 'https://example.com/external',
          },
          notice_b: {
            tenantId: TENANT,
            imageUrl: url(withoutPathImage),
          },
        },
      },
    });

    expect(result.retainPaths.has(withPathImage)).toBe(true);
    expect(result.retainPaths.has(withPathAudio)).toBe(true);
    expect(result.retainPaths.has(withoutPathImage)).toBe(true);
    expect(result.countsBySource.notices).toBe(3);
    // `linkUrl` is an external link and is never read.
    expect(result.crossTenantReferenceCount).toBe(0);
  });
});

describe('collectTenantReferenceSet — source 6, students', () => {
  it('collects a photo for a student at every status', async () => {
    const active = 'student_profiles/acme/k_a_profile.jpg';
    const inactive = 'student_profiles/acme/k_i_profile.jpg';
    const suspended = 'student_profiles/acme/k_s_profile.jpg';

    const { result } = await collect({
      collections: {
        students: {
          s_active: { tenantId: TENANT, status: 'active', profileImageUrl: url(active) },
          s_inactive: { tenantId: TENANT, status: 'inactive', profileImageUrl: url(inactive) },
          s_suspended: { tenantId: TENANT, status: 'suspended', profileImageUrl: url(suspended) },
        },
      },
    });

    // Copying the rollup job's `status == 'active'` filter would delete the
    // suspended student's photo and make reinstatement lossy.
    expect(result.retainPaths.has(active)).toBe(true);
    expect(result.retainPaths.has(inactive)).toBe(true);
    expect(result.retainPaths.has(suspended)).toBe(true);
    expect(result.countsBySource.students).toBe(3);
  });
});

describe('collectTenantReferenceSet — source 7, tenant branding', () => {
  it('collects all five branding fields plus a generic extra leaf', async () => {
    const logo = 'tenant-branding/acme/logo_k_1111.png';
    const hero = 'tenant-branding/acme/hero_k_1111.png';
    const nestedLogo = 'tenant-branding/acme/logo_k_2222.png';
    const nestedHero = 'tenant-branding/acme/hero_k_2222.png';
    const accent = 'tenant-branding/acme/accent_k_2222.png';
    const futureField = 'tenant-branding/acme/badge_k_3333.png';

    const { result } = await collect({
      collections: {
        tenants: {
          [TENANT]: {
            tenantId: TENANT,
            logoUrl: url(logo),
            heroImageUrl: url(hero),
            branding: {
              logoUrl: url(nestedLogo),
              heroImageUrl: url(nestedHero),
              accentImageUrl: url(accent),
              // A sixth field nobody has written a rule for yet.
              badgeImageUrl: url(futureField),
              tagline: 'Learn with us',
            },
          },
        },
      },
    });

    // Reading only `logoUrl` would report the other five as orphans.
    for (const path of [logo, hero, nestedLogo, nestedHero, accent, futureField]) {
      expect(result.retainPaths.has(path)).toBe(true);
    }
    expect(result.countsBySource.tenant_branding).toBe(6);
    // The tagline is a string leaf too; it simply names no object.
    expect(result.malformedReferences).toBe(0);
  });
});

// ─── Source 8: profile pictures, by derivation ───────────────────────────────

describe('collectTenantReferenceSet — source 8, derived profile pictures', () => {
  function writerPath(email: string): string {
    const resolved = resolveUploadObjectPath({
      purpose: 'profilePicture',
      tenantId: TENANT,
      email,
      uploadKeyHash: null,
      now: 0,
      randomSuffix: '',
    });
    if (!resolved.ok) throw new Error('fixture email does not resolve');
    return resolved.objectPath;
  }

  it('derives a path per membership, profile and chat participant email', async () => {
    const memberEmail = 'Revoked.Member@Example.com';
    const profileEmail = 'profile@example.com';
    const senderEmail = 'sender@example.com';
    const recipientEmail = 'recipient@example.com';

    const { result } = await collect({
      tree: chatTree({
        c_8: { '-msg_1': { sender: senderEmail, recipientId: recipientEmail } },
      }),
      collections: {
        tenantMemberships: {
          // Memberships are soft-revoked, never hard-deleted, so a departed
          // member's avatar stays retained. The email is a FIELD; the document id
          // is `{tenantId}_{uid}`.
          [`${TENANT}_uid-1`]: { tenantId: TENANT, status: 'revoked', email: memberEmail },
        },
        tenantProfiles: {
          [`${TENANT}_profile_at_example_com`]: {
            tenantId: TENANT,
            email: profileEmail,
            // The second, independent proof — used in addition to the derivation.
            customImageURL: url(writerPath(profileEmail)),
            photoURL: 'https://lh3.googleusercontent.com/a/default-user',
          },
        },
      },
    });

    for (const email of [memberEmail, profileEmail, senderEmail, recipientEmail]) {
      expect(result.retainPaths.has(writerPath(email))).toBe(true);
    }
    // Four derivations plus the one `customImageURL` proof; the Google CDN
    // `photoURL` resolves to a foreign bucket and is ignored.
    expect(result.countsBySource.profile_pictures_derived).toBe(5);
  });

  it('retains an avatar that no document field references any more', async () => {
    // `toggleProfilePictureSource` overwrites `photoURL` with the Google CDN url
    // and `customImageURL` is `deleteField()`'d, so field reading alone would
    // delete a live avatar.
    const email = 'toggled@example.com';

    const { result } = await collect({
      collections: {
        tenantMemberships: {
          [`${TENANT}_uid-9`]: { tenantId: TENANT, status: 'active', email },
        },
        tenantProfiles: {
          [`${TENANT}_toggled_at_example_com`]: {
            tenantId: TENANT,
            email,
            photoURL: 'https://lh3.googleusercontent.com/a/toggled',
          },
        },
      },
    });

    expect(result.retainPaths.has(writerPath(email))).toBe(true);
  });

  it('never derives from a document id', async () => {
    // The id carries a uid, not the email; deriving from it would retain the
    // wrong object and leave the real avatar unreferenced.
    const email = 'field.only@example.com';

    const { result } = await collect({
      collections: {
        tenantMemberships: {
          [`${TENANT}_uid-abcdef`]: { tenantId: TENANT, status: 'active', email },
        },
      },
    });

    expect([...result.retainPaths]).toEqual([writerPath(email)]);
  });
});

// ─── Cross-cutting: scope, malformed values, the fingerprint, no writes ──────

describe('collectTenantReferenceSet — scope, malformed values and the fingerprint', () => {
  it('records a cross-tenant reference, EXCLUDES it, and continues the run', async () => {
    const ours = 'notices/acme/notice_k_own.png';
    const theirs = 'receipts/other-tenant/fee_1/k_x_march.pdf';
    // The prefix-collision case a naive `startsWith` would admit.
    const neighbour = 'notices/acme-2/notice_k_neighbour.png';

    const { result } = await collect({
      collections: {
        notices: {
          notice_a: { tenantId: TENANT, imageUrl: url(ours) },
          notice_b: { tenantId: TENANT, imageUrl: url(theirs) },
          notice_c: { tenantId: TENANT, imageUrl: url(neighbour) },
        },
      },
    });

    expect(result.retainPaths.has(ours)).toBe(true);
    expect(result.retainPaths.has(theirs)).toBe(false);
    expect(result.retainPaths.has(neighbour)).toBe(false);
    expect(result.crossTenantReferences.sort()).toEqual([neighbour, theirs].sort());
    expect(result.crossTenantReferenceCount).toBe(2);
    // A cross-tenant reference is an alarm, not an abort: the run continues.
    expect(result.abortReason).toBeNull();
    expect(result.failedSources).toEqual([]);
    for (const path of result.retainPaths) {
      expect(classifyTenantScopedPath(path, TENANT).ok).toBe(true);
    }
  });

  it('counts a malformed reference and reports the malformed_reference abort', async () => {
    const good = 'notices/acme/notice_k_good.png';

    const { result } = await collect({
      collections: {
        notices: {
          notice_a: { tenantId: TENANT, imageUrl: url(good) },
          // `decodeURIComponent` throws on `%zz`: a reference we cannot parse
          // means some object is referenced and we cannot tell which.
          notice_b: {
            tenantId: TENANT,
            imageUrl: `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/%zz`,
          },
        },
      },
    });

    expect(result.malformedReferences).toBe(1);
    expect(result.retainPaths.has(good)).toBe(true);
    expect(result.abortReason).toBe('malformed_reference');
  });

  it('reports reference_cap_exceeded rather than truncating silently', async () => {
    const { result } = await collect({
      maxReferences: 2,
      collections: {
        notices: {
          notice_a: { tenantId: TENANT, imageUrl: url('notices/acme/a.png') },
          notice_b: { tenantId: TENANT, imageUrl: url('notices/acme/b.png') },
          notice_c: { tenantId: TENANT, imageUrl: url('notices/acme/c.png') },
          notice_d: { tenantId: TENANT, imageUrl: url('notices/acme/d.png') },
        },
      },
    });

    expect(result.abortReason).toBe('reference_cap_exceeded');
    expect(result.retainPaths.size).toBeGreaterThan(2);
    // The ceiling bounds memory: admission stops one past the cap rather than
    // being discovered after the set has grown.
    expect(result.retainPaths.size).toBe(3);
  });

  it('produces the identical fingerprint for equal sets built in different orders', async () => {
    const first = 'notices/acme/notice_k_first.png';
    const second = 'notices/acme/notice_k_second.png';

    const forward = await collect({
      collections: {
        notices: {
          notice_a: { tenantId: TENANT, imageUrl: url(first) },
          notice_b: { tenantId: TENANT, imageUrl: url(second) },
        },
      },
    });
    const reversed = await collect({
      collections: {
        notices: {
          notice_b: { tenantId: TENANT, imageUrl: url(second, 'other-token') },
          notice_a: { tenantId: TENANT, imageUrl: url(first, 'other-token') },
        },
      },
    });

    expect([...forward.result.retainPaths]).toEqual([first, second]);
    expect([...reversed.result.retainPaths]).toEqual([second, first]);
    expect(reversed.result.referenceFingerprint).toBe(forward.result.referenceFingerprint);

    const different = await collect({
      collections: { notices: { notice_a: { tenantId: TENANT, imageUrl: url(first) } } },
    });
    expect(different.result.referenceFingerprint).not.toBe(forward.result.referenceFingerprint);
  });

  it('initialises a count for every source so a silent zero is visible', async () => {
    const { result } = await collect({});

    expect(Object.keys(result.countsBySource).sort()).toEqual([...REFERENCE_SOURCE_IDS].sort());
    for (const id of REFERENCE_SOURCE_IDS) {
      expect(result.countsBySource[id as ReferenceSourceId]).toBe(0);
    }
    expect(result.retainPaths.size).toBe(0);
    expect(result.abortReason).toBeNull();
  });

  it('attempts no write to Firestore or the Realtime Database', async () => {
    const { mutations } = await collect({
      tree: chatTree({ c_1: { '-msg_1': { fileUrl: url('chat-files/acme/c_1/k_a_x.pdf') } } }),
      collections: {
        notices: { notice_a: { tenantId: TENANT, imageUrl: url('notices/acme/x.png') } },
        tenants: { [TENANT]: { logoUrl: url('tenant-branding/acme/logo_k_1.png') } },
      },
    });

    expect(mutations).toEqual([]);
  });
});

// ─── The regression gate for the central finding ─────────────────────────────

describe('collectTenantReferenceSet — chat attachments live in the RTDB', () => {
  const onlyInRtdb = 'chat-files/acme/c_rtdb/k_only_photo.jpg';

  /** Firestore holds no reference to the chat object at all. */
  const firestoreWithoutChat = {
    notices: { notice_a: { tenantId: TENANT, imageUrl: url('notices/acme/notice_k_1.png') } },
    fees: { fee_1: { tenantId: TENANT, receipts: [{ url: url('receipts/acme/fee_1/k_1_a.pdf') }] } },
  };

  it('collects an attachment referenced ONLY in the Realtime Database', async () => {
    const { result } = await collect({
      collections: firestoreWithoutChat,
      tree: chatTree({ c_rtdb: { '-msg_1': { fileUrl: url(onlyInRtdb) } } }),
    });

    expect(result.retainPaths.has(onlyInRtdb)).toBe(true);
    expect(result.countsBySource.rtdb_chat_messages).toBe(1);
    expect(result.abortReason).toBeNull();
  });

  it('aborts rather than returning a set with no chat paths when the RTDB source fails', async () => {
    const { result } = await collect({
      collections: firestoreWithoutChat,
      tree: chatTree({ c_rtdb: { '-msg_1': { fileUrl: url(onlyInRtdb) } } }),
      rtdbFailure: { value: new Error('PERMISSION_DENIED: Client doesn\'t have permission') },
    });

    // The set genuinely has no chat path — which is precisely why the run must
    // not be allowed to judge the bucket against it.
    expect(result.retainPaths.has(onlyInRtdb)).toBe(false);
    expect(result.failedSources).toEqual([
      { id: 'rtdb_chat_messages', message: "PERMISSION_DENIED: Client doesn't have permission" },
    ]);
    expect(result.abortReason).toBe('reference_source_failed');
    // The Firestore sources still ran, so the report shows what was readable.
    expect(result.countsBySource.notices).toBe(1);
    expect(result.countsBySource.fees).toBe(1);
  });
});
