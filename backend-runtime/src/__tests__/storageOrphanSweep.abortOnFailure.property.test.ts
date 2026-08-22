// Feature: storage-orphan-cleanup, Property 9: A reference-enumeration failure aborts rather than deletes
/**
 * Property 9: A reference-enumeration failure aborts rather than deletes
 * **Validates: Requirements 9.1, 9.2, 9.3, 9.6, 5.9**
 *
 * *For any* non-empty subset of the eight Reference_Sources made to fail — with
 * any thrown value: an `Error`, a permission error, a timeout, a string, a
 * number, `null`, `undefined`, or an object whose `message` getter and
 * `toString` both throw — `collectTenantReferenceSet` **resolves** rather than
 * rejecting, records every failing source in `failedSources` with a non-empty
 * message, and reports the abort decision on its RETURN VALUE.
 *
 * The same holds for `malformedReferences > 0` and for a retain set that exceeds
 * `maxReferences`.
 *
 * This is the property that makes the Realtime Database dependency safe. If the
 * RTDB is unreachable, or `FIREBASE_DATABASE_URL` is unset, or a permission
 * changes, the enumeration stops — rather than concluding that a tenant's entire
 * `chat-files/` prefix is unreferenced.
 *
 * ── What is asserted here, and what is asserted in task 6.1 ─────────────────
 *
 * `sweepTenant` does not exist yet (task 6.1 lands the gate that turns this
 * return value into `status: 'aborted'`, `abortReason: 'reference_source_failed'`
 * and zero quarantined objects). So this file asserts exactly what Phase 1
 * guarantees on its own:
 *
 *   - the collector resolves rather than rejecting, so the caller always reaches
 *     its gate;
 *   - the failing source is named in `failedSources`;
 *   - `abortReason` is non-null and correct, i.e. the abort condition travels on
 *     the return value rather than depending on the caller recalling the three
 *     conditions (Req 9.11);
 *   - nothing was mutated, which is the "having quarantined zero objects" claim
 *     as far as Phase 1 can make it: the collector is handed no bucket at all,
 *     and every mutating method the Firestore and RTDB fakes expose records its
 *     call, so any write attempt would show up.
 *
 * The remaining half of the property — that `sweepTenant` turns a non-null
 * `abortReason` into an aborted run that quarantines nothing — is asserted in
 * task 6.1's suite, against the gate that consumes this value.
 */

import * as fc from 'fast-check';

import { buildFirebaseDownloadUrl, classifyTenantScopedPath } from '../lib/storageObjectRef';
import {
  REFERENCE_SOURCE_IDS,
  collectTenantReferenceSet,
  type ReferenceSourceId,
} from '../jobs/storageOrphanSweep';

const BUCKET = 'tution-app-6c0c3.firebasestorage.app';
const TENANT = 'acme';

function url(objectPath: string): string {
  return buildFirebaseDownloadUrl(BUCKET, objectPath, 'tok');
}

// ─── Fakes ───────────────────────────────────────────────────────────────────

type DocData = Record<string, unknown>;

/**
 * A healthy fixture with real references in EVERY source, so a run with one
 * source failing can be observed to keep enumerating the rest.
 */
const COLLECTIONS: Record<string, Record<string, DocData>> = {
  videoTranscodes: {
    t_1: {
      tenantId: TENANT,
      status: 'done',
      transcodedPath: 'chat-files/acme/c_1/k_v_clip_h264.mp4',
    },
  },
  sharedFiles: {
    tok_1: { tenantId: TENANT, file: { url: url('chat-files/acme/c_1/k_s_deck.pdf') } },
  },
  fees: {
    fee_1: { tenantId: TENANT, receipts: [{ url: url('receipts/acme/fee_1/k_f_march.pdf') }] },
  },
  notices: {
    notice_1: { tenantId: TENANT, imageUrl: url('notices/acme/notice_k_n.png') },
  },
  students: {
    s_1: {
      tenantId: TENANT,
      status: 'suspended',
      profileImageUrl: url('student_profiles/acme/k_st_profile.jpg'),
    },
  },
  tenants: {
    [TENANT]: { logoUrl: url('tenant-branding/acme/logo_k_b.png') },
  },
  tenantMemberships: {
    [`${TENANT}_uid-1`]: { tenantId: TENANT, status: 'revoked', email: 'member@example.com' },
  },
  tenantProfiles: {
    [`${TENANT}_profile`]: { tenantId: TENANT, email: 'profile@example.com' },
  },
};

const CHAT_TREE = {
  tenantChat: {
    [TENANT]: {
      conversationMessages: {
        c_1: {
          '-msg_1': {
            sender: 'teacher@example.com',
            recipientId: 'student@example.com',
            fileUrl: url('chat-files/acme/c_1/k_c_photo.jpg'),
          },
        },
      },
    },
  },
};

function createFakeFirestore(failures: Record<string, unknown>, mutations: string[]) {
  const failIfConfigured = (name: string): void => {
    if (Object.prototype.hasOwnProperty.call(failures, name)) throw failures[name];
  };

  const docSnapshot = (id: string, data: DocData | undefined) => ({
    id,
    exists: data !== undefined,
    data: () => data,
  });

  const collection = (name: string) => {
    const filters: [string, string, unknown][] = [];
    const query: Record<string, unknown> = {
      where(field: string, operator: string, value: unknown) {
        filters.push([field, operator, value]);
        return query;
      },
      async get() {
        failIfConfigured(name);
        const entries = Object.entries(COLLECTIONS[name] ?? {}).filter(([, data]) =>
          filters.every(([field, operator, value]) => operator === '==' && data?.[field] === value)
        );
        return {
          size: entries.length,
          empty: entries.length === 0,
          docs: entries.map(([id, data]) => docSnapshot(id, data)),
          forEach(callback: (doc: ReturnType<typeof docSnapshot>) => void) {
            for (const [id, data] of entries) callback(docSnapshot(id, data));
          },
        };
      },
      doc(id: string) {
        return {
          async get() {
            failIfConfigured(name);
            return docSnapshot(id, (COLLECTIONS[name] ?? {})[id]);
          },
          set: async () => void mutations.push(`set ${name}/${id}`),
          update: async () => void mutations.push(`update ${name}/${id}`),
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

  return {
    collection,
    doc: (path: string) => ({
      get: async () => docSnapshot(path, undefined),
      set: async () => void mutations.push(`set ${path}`),
    }),
    batch: () => ({
      set: () => mutations.push('batch.set'),
      delete: () => mutations.push('batch.delete'),
      commit: async () => void mutations.push('batch.commit'),
    }),
    runTransaction: async () => void mutations.push('runTransaction'),
  };
}

function createFakeRtdb(
  tree: Record<string, unknown>,
  failure: { value: unknown } | null,
  mutations: string[]
) {
  const resolveNode = (segments: string[]): unknown => {
    let node: unknown = tree;
    for (const segment of segments) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return node;
  };

  const makeQuery = (segments: string[], cursor: string | null, limit: number | null) => {
    const path = segments.join('/');
    const query: Record<string, unknown> = {
      orderByKey: () => makeQuery(segments, cursor, limit),
      startAfter: (value: string) => makeQuery(segments, String(value), limit),
      limitToFirst: (count: number) => makeQuery(segments, cursor, count),
      child: (key: string) => makeQuery([...segments, key], null, null),
      async get() {
        if (failure) throw failure.value;
        const target = resolveNode(segments);
        let entries: [string, unknown][] =
          target !== null && typeof target === 'object'
            ? Object.entries(target as Record<string, unknown>).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0
              )
            : [];
        if (cursor !== null) entries = entries.filter(([key]) => key > cursor);
        if (limit !== null) entries = entries.slice(0, limit);
        return {
          exists: () => entries.length > 0,
          val: () => Object.fromEntries(entries),
          forEach(callback: (child: { key: string; val: () => unknown }) => boolean | void) {
            for (const [key, value] of entries) {
              if (callback({ key, val: () => value }) === true) return true;
            }
            return false;
          },
        };
      },
      set: async () => void mutations.push(`set ${path}`),
      update: async () => void mutations.push(`update ${path}`),
      remove: async () => void mutations.push(`remove ${path}`),
      push: () => {
        mutations.push(`push ${path}`);
        return makeQuery([...segments, 'generated'], null, null);
      },
      transaction: async () => void mutations.push(`transaction ${path}`),
    };
    return query;
  };

  return { ref: (path: string) => makeQuery(String(path).split('/').filter(Boolean), null, null) };
}

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Which read a source fails on. `profile_pictures_derived` reads two
 * collections, so either of them failing must land under that one source id.
 */
const SOURCE_FAILURE_TARGETS: Record<ReferenceSourceId, readonly string[]> = {
  rtdb_chat_messages: ['__rtdb__'],
  video_transcodes: ['videoTranscodes'],
  shared_files: ['sharedFiles'],
  fees: ['fees'],
  notices: ['notices'],
  students: ['students'],
  tenant_branding: ['tenants'],
  profile_pictures_derived: ['tenantMemberships', 'tenantProfiles'],
};

/** An object whose `message` getter AND `toString` both throw. */
function hostileThrowable(): unknown {
  return {
    get message(): string {
      throw new Error('message getter exploded');
    },
    toString(): string {
      throw new Error('toString exploded');
    },
  };
}

/**
 * Every thrown-value shape the property names. `fc.constantFrom` would share one
 * instance across runs, which is harmless for these values, but the hostile
 * object is built per draw so its getters cannot be memoised by accident.
 */
const thrownValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null).map(() => new Error('boom')),
  fc.constant(null).map(() => {
    const error = new Error("PERMISSION_DENIED: Client doesn't have permission to access the desired data");
    error.name = 'FirebaseError';
    return error;
  }),
  fc.constant(null).map(() => {
    const error = new Error('Deadline exceeded after 60.001s');
    error.name = 'DeadlineExceeded';
    return error;
  }),
  fc.constant(null).map(() => new Error('')),
  fc.string({ minLength: 1, maxLength: 40 }),
  fc.constant(''),
  fc.integer(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(null).map(() => hostileThrowable()),
  fc.constant(null).map(() => ({ code: 'permission-denied' }))
);

/** A non-empty subset of the eight sources, each with its own thrown value. */
const failingSourcesArb = fc
  .uniqueArray(fc.constantFrom(...REFERENCE_SOURCE_IDS), {
    minLength: 1,
    maxLength: REFERENCE_SOURCE_IDS.length,
  })
  .chain((ids) =>
    fc.tuple(
      fc.constant(ids),
      fc.array(thrownValueArb, { minLength: ids.length, maxLength: ids.length }),
      // Which of a multi-read source's collections throws.
      fc.array(fc.nat({ max: 1 }), { minLength: ids.length, maxLength: ids.length })
    )
  );

/**
 * Values that the Path_Mapper classifies as `malformed` — the "some object is
 * referenced and we cannot tell which" case, as opposed to `foreign_bucket` or
 * `not_a_storage_url`, which are ordinary and ignored.
 */
const malformedUrlArb = fc.constantFrom(
  // `decodeURIComponent` throws.
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/%zz`,
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/%`,
  // Traversal survives neither decode nor normalisation.
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/notices%2Facme%2F..%2F..%2Fetc`,
  // An empty segment.
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/notices%2F%2Fx.png`,
  // The Firebase Storage API host naming no object at all.
  'https://firebasestorage.googleapis.com/v0/b/',
  `https://${BUCKET}/`
);

// ─── The properties ──────────────────────────────────────────────────────────

let consoleLog: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
});

describe('Property 9: a reference-enumeration failure aborts rather than deletes', () => {
  it('resolves with every failing source recorded and the abort on the return value', async () => {
    await fc.assert(
      fc.asyncProperty(failingSourcesArb, async ([failingIds, thrownValues, targetChoices]) => {
        const mutations: string[] = [];
        const firestoreFailures: Record<string, unknown> = {};
        let rtdbFailure: { value: unknown } | null = null;

        failingIds.forEach((id, index) => {
          const targets = SOURCE_FAILURE_TARGETS[id];
          const target = targets[targetChoices[index] % targets.length];
          if (target === '__rtdb__') {
            rtdbFailure = { value: thrownValues[index] };
          } else {
            firestoreFailures[target] = thrownValues[index];
          }
        });

        const result = await collectTenantReferenceSet({
          db: createFakeFirestore(firestoreFailures, mutations) as never,
          rtdb: createFakeRtdb(CHAT_TREE, rtdbFailure, mutations) as never,
          tenantId: TENANT,
          bucketName: BUCKET,
          maxReferences: 1_000,
        });

        // 1. It resolved — reaching this line is the assertion — and named every
        //    failing source exactly once.
        const reported = result.failedSources.map((entry) => entry.id);
        expect([...reported].sort()).toEqual([...failingIds].sort());

        // 2. Any thrown value became a usable, non-empty message.
        for (const entry of result.failedSources) {
          expect(typeof entry.message).toBe('string');
          expect(entry.message.length).toBeGreaterThan(0);
        }

        // 3. The abort travels on the return value, and a failed source outranks
        //    the other two conditions.
        expect(result.abortReason).toBe('reference_source_failed');

        // 4. Nothing was mutated: no Firestore write, no RTDB write. The
        //    collector is handed no bucket at all, so no object could move.
        expect(mutations).toEqual([]);

        // 5. Whatever WAS readable is still a well-formed, tenant-scoped retain
        //    set — the enumeration continued past the failure rather than
        //    unwinding.
        for (const path of result.retainPaths) {
          expect(classifyTenantScopedPath(path, TENANT).ok).toBe(true);
        }
        expect(result.referenceFingerprint).toMatch(/^[0-9a-f]{64}$/);

        // 6. Every source that did NOT fail still contributed its references, so
        //    a partial report is honest about what was read.
        const failing = new Set<ReferenceSourceId>(failingIds);
        for (const id of REFERENCE_SOURCE_IDS) {
          if (!failing.has(id)) {
            expect(result.countsBySource[id]).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('reports malformed_reference for any unparseable reference value', async () => {
    await fc.assert(
      fc.asyncProperty(
        malformedUrlArb,
        fc.constantFrom('imageUrl', 'audioUrl', 'imageStoragePath', 'audioStoragePath'),
        async (malformed, field) => {
          const mutations: string[] = [];
          COLLECTIONS.notices = {
            notice_1: { tenantId: TENANT, imageUrl: url('notices/acme/notice_k_n.png') },
            notice_malformed: { tenantId: TENANT, [field]: malformed },
          };
          try {
            const result = await collectTenantReferenceSet({
              db: createFakeFirestore({}, mutations) as never,
              rtdb: createFakeRtdb(CHAT_TREE, null, mutations) as never,
              tenantId: TENANT,
              bucketName: BUCKET,
              maxReferences: 1_000,
            });

            expect(result.failedSources).toEqual([]);
            expect(result.malformedReferences).toBeGreaterThan(0);
            expect(result.abortReason).toBe('malformed_reference');
            expect(mutations).toEqual([]);
          } finally {
            COLLECTIONS.notices = {
              notice_1: { tenantId: TENANT, imageUrl: url('notices/acme/notice_k_n.png') },
            };
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('reports reference_cap_exceeded and stops admitting rather than truncating', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 13, max: 40 }),
        async (maxReferences, noticeCount) => {
          const mutations: string[] = [];
          const notices: Record<string, DocData> = {};
          for (let index = 0; index < noticeCount; index += 1) {
            notices[`notice_${String(index).padStart(3, '0')}`] = {
              tenantId: TENANT,
              imageUrl: url(`notices/acme/notice_k_${index}.png`),
            };
          }
          COLLECTIONS.notices = notices;
          try {
            const result = await collectTenantReferenceSet({
              db: createFakeFirestore({}, mutations) as never,
              rtdb: createFakeRtdb(CHAT_TREE, null, mutations) as never,
              tenantId: TENANT,
              bucketName: BUCKET,
              maxReferences,
            });

            expect(result.failedSources).toEqual([]);
            expect(result.abortReason).toBe('reference_cap_exceeded');
            // The caller's `size > maxReferences` gate stays true …
            expect(result.retainPaths.size).toBeGreaterThan(maxReferences);
            // … while the ceiling still bounds memory: admission stops one past
            // the cap rather than being discovered after the set has grown.
            expect(result.retainPaths.size).toBe(maxReferences + 1);
            expect(mutations).toEqual([]);
          } finally {
            COLLECTIONS.notices = {
              notice_1: { tenantId: TENANT, imageUrl: url('notices/acme/notice_k_n.png') },
            };
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
