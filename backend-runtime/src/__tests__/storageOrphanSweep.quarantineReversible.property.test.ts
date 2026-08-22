// Feature: storage-orphan-cleanup, Property 12: Quarantine is reversible and never loses bytes
/**
 * Property 12: Quarantine is reversible and never loses bytes
 * **Validates: Requirements 11.3, 11.4, 11.6, 11.7, 11.8, 11.10, 11.11, 11.12, 11.13**
 *
 * *For any* generated failure at any step of `quarantineObject` — the copy fails,
 * the verify fails, the verified size mismatches, the manifest write fails, the
 * delete fails — the object's bytes remain retrievable from the original path, the
 * quarantine path, or both. **There is no interleaving in which both are absent**
 * (Req 11.10).
 *
 * And *for any* successful move, `restoreFromQuarantine` puts the object back at
 * **exactly** its original path (Req 11.11) with its metadata — the
 * `firebaseStorageDownloadTokens` bag included (Req 11.12) — so the download URL
 * already stored on the owning record resolves again. Restore refuses an occupied
 * destination and changes nothing (Req 11.13).
 *
 * ── Why this drives the mover directly ──────────────────────────────────────
 *
 * The property is about the MOVE, not about the run: it quantifies over failure
 * interleavings of one four-step operation, and the listing loop contributes
 * nothing to it. Driving `runStorageOrphanSweep` over generated multi-page
 * listings for each of a hundred runs would cost minutes and assert the same
 * thing less directly. The loop's own obligations — the ceiling, the
 * at-most-once-per-`sweepId` rule, copy-before-delete for every object in a real
 * run — belong to Property 7 and to the integration suite.
 *
 * ── Why the invariant is sampled mid-flight, not only at the end ────────────
 *
 * "At every point of a quarantine move" is a claim about the intermediate states,
 * so the harness's failure hooks double as observation points: each one fires at
 * the instant its step runs, and each snapshots which locations then hold the
 * bytes. A final-state-only assertion would pass for a mover that deleted the
 * original first and re-created it on failure, which is not what Req 11.3 says.
 *
 * The complement — that no path OUTSIDE the quarantine namespace is reachable
 * from these two functions — is Property 2 (`storageObjectRef.confinement`) and
 * Property 8 (`storageObjectRef.quarantineDomain`), both asserted over hostile
 * generated input against the pure builders. This file generates only in-scope
 * paths and asserts what the mover does with them.
 */

import * as fc from 'fast-check';

import {
  buildQuarantinePath,
  buildFirebaseDownloadUrl,
  resolveBucketObjectPath,
  QUARANTINE_PREFIX,
  STORAGE_TENANT_CATEGORIES,
} from '../lib/storageObjectRef';
import {
  quarantineManifestPath,
  quarantineObject,
  restoreFromQuarantine,
  type SweepBucket,
} from '../jobs/storageOrphanSweep';
import {
  BUCKET_NAME,
  createFakeBucket,
  createFakeFirestore,
  createOperationLog,
  iso,
  type FakeBucket,
  type FakeObject,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
const OLD = iso(NOW - 400 * DAY);

/** Where a generated failure is injected. `none` is the happy path. */
type Injection = 'none' | 'copy' | 'verify' | 'size' | 'manifest' | 'delete';

interface Move {
  tenantId: string;
  sweepId: string;
  objectPath: string;
  size: number;
  token: string;
  /** `false` ⇒ the listing could not read a size, so `bytes: null` is passed. */
  bytesKnown: boolean;
  injection: Injection;
  failureValue: unknown;
}

// ─── Generators ──────────────────────────────────────────────────────────────
//
// Constrained to the input space the mover actually receives: a path its own
// Scope_Guard accepts, for a tenant it was called with. Filenames are drawn from
// the shapes that appear in this bucket — spaces, `+`, `%`, `#`, `?`, `&`, `=`,
// non-ASCII and emoji — because the destination is built by string concatenation
// and a filename that survives `buildQuarantinePath` must survive the round trip
// through `parseQuarantinePath` too.

const tenantIdArb = fc.constantFrom('acme', 'acme-2', 't_9f2a', 'tenant.one', 'a');

const sweepIdArb = fc.constantFrom(
  'sweep_1712000000000_7f3a',
  'sweep_test_0001',
  'sweep-2',
  's'
);

const filenameArb = fc.constantFrom(
  'photo.jpg',
  'March invoice.pdf',
  'a+b%20c.png',
  'holiday 🙂.jpg',
  'k_aa11_march.pdf',
  'weird#?&=.bin',
  'clip_h264.mp4',
  'notice_audio.m4a'
);

/** Zero or more segments between the tenant segment and the filename. */
const middleArb = fc.constantFrom<string[]>(
  [],
  ['c_9f2a'],
  ['fee_77'],
  ['audio'],
  ['c_9f2a', 'nested']
);

const tokenArb = fc.constantFrom(
  'tok-original',
  '7f3a1c9e-2b4d-4f6a-8c1e-0d5b9a3e7c21',
  'a',
  'TOKEN_WITH_UNDERSCORES'
);

/**
 * Thrown values, not just `Error`s: the mover coerces whatever it caught into a
 * message through `describeThrownValue`, and a fake that only ever threw `Error`
 * would not exercise that. `undefined` is excluded because the harness's hooks
 * read it as "do not fail".
 */
const failureValueArb = fc.constantFrom<unknown>(
  new Error('storage: operation denied'),
  'a bare string failure',
  42,
  null
);

const moveArb: fc.Arbitrary<Move> = fc
  .record({
    category: fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
    tenantId: tenantIdArb,
    sweepId: sweepIdArb,
    middle: middleArb,
    filename: filenameArb,
    size: fc.integer({ min: 0, max: 5_000_000 }),
    token: tokenArb,
    bytesKnown: fc.boolean(),
    injection: fc.constantFrom<Injection>('none', 'copy', 'verify', 'size', 'manifest', 'delete'),
    failureValue: failureValueArb,
  })
  .map((generated) => ({
    tenantId: generated.tenantId,
    sweepId: generated.sweepId,
    objectPath: [generated.category, generated.tenantId, ...generated.middle, generated.filename].join(
      '/'
    ),
    size: generated.size,
    token: generated.token,
    bytesKnown: generated.bytesKnown,
    injection: generated.injection,
    failureValue: generated.failureValue,
  }));

// ─── The rig ─────────────────────────────────────────────────────────────────

interface Attempt {
  log: OperationLog;
  bucket: FakeBucket;
  db: ReturnType<typeof createFakeFirestore>;
  quarantinePath: string;
  /**
   * Where the bytes were retrievable at each mid-flight observation point, in
   * order. Every entry must be non-empty — that IS Req 11.10.
   */
  snapshots: ('original' | 'quarantine')[][];
  result: Awaited<ReturnType<typeof quarantineObject>>;
}

async function attemptMove(move: Move): Promise<Attempt> {
  const log = createOperationLog();
  const quarantinePath = buildQuarantinePath({
    tenantId: move.tenantId,
    sweepId: move.sweepId,
    objectPath: move.objectPath,
  });
  const source: FakeObject = {
    name: move.objectPath,
    size: move.size,
    timeCreated: OLD,
    updated: OLD,
    metadata: { firebaseStorageDownloadTokens: move.token },
  };

  const snapshots: ('original' | 'quarantine')[][] = [];
  let bucket!: FakeBucket;
  const observe = (): void => {
    const held: ('original' | 'quarantine')[] = [];
    if (bucket.contents().has(move.objectPath)) held.push('original');
    if (bucket.contents().has(quarantinePath)) held.push('quarantine');
    snapshots.push(held);
  };

  const manifest = quarantineManifestPath(move.tenantId, move.sweepId, move.objectPath);

  bucket = createFakeBucket({
    log,
    objects: [source],
    // Each hook observes FIRST and then decides whether to fail, so the snapshot
    // describes the state at the instant that step ran rather than after it.
    failCopy: () => {
      observe();
      return move.injection === 'copy' ? move.failureValue : undefined;
    },
    failGetMetadata: () => {
      observe();
      return move.injection === 'verify' ? move.failureValue : undefined;
    },
    metadataSizeOverride: (path) =>
      move.injection === 'size' && path === quarantinePath ? move.size + 1 : undefined,
    failDelete: () => {
      observe();
      return move.injection === 'delete' ? move.failureValue : undefined;
    },
  });

  const db = createFakeFirestore({
    log,
    ...(move.injection === 'manifest' ? { writeFailures: { [manifest]: move.failureValue } } : {}),
  });

  const result = await quarantineObject({
    bucket: bucket as unknown as SweepBucket,
    db: db as never,
    tenantId: move.tenantId,
    sweepId: move.sweepId,
    objectPath: move.objectPath,
    bytes: move.bytesKnown ? move.size : null,
    quarantineRetentionDays: 7,
    nowMs: NOW,
  });

  return { log, bucket, db, quarantinePath, snapshots, result };
}

/**
 * The stage the mover must report for a given injection.
 *
 * ── `size` used to be conditional on `bytesKnown`, and that was the bug ──────
 *
 * This model previously read `move.bytesKnown ? 'verify' : null`, on the argument
 * that the mover can only compare byte sizes when the listing gave it one, so an
 * overridden destination size on a `bytes: null` move is not a mismatch it can see
 * — and that refusing every move whose source size was unreadable "would strand
 * exactly the objects whose metadata is broken".
 *
 * That argument is the wrong way round for this feature. The consequence of the
 * `null` branch skipping the comparison is that a copy which landed at the right
 * path with the WRONG BYTES is accepted and the original is then hard-deleted —
 * permanent loss. The consequence of refusing is that an unreferenced orphan stays
 * in the live prefix, counted as a `quarantineFailures` with a stated reason. The
 * design's own posture decides between those two: "a false positive destroys user
 * data; a false negative wastes bytes."
 *
 * So the mover now makes the comparison TOTAL — with no listing size it reads the
 * SOURCE's size at move time and compares against that, and refuses only when
 * neither side yields a size at all. `size` is therefore unconditional here: a
 * destination whose size differs from the source is a `verify` failure whether or
 * not the listing could read a size. Note the injection overrides the DESTINATION
 * only, so the source read is what the mismatch is measured against.
 */
function expectedStage(move: Move): 'copy' | 'verify' | 'manifest' | 'delete' | null {
  switch (move.injection) {
    case 'copy':
      return 'copy';
    case 'verify':
      return 'verify';
    case 'size':
      return 'verify';
    case 'manifest':
      return 'manifest';
    case 'delete':
      return 'delete';
    default:
      return null;
  }
}

function bucketOps(log: OperationLog): { method: string; target: string }[] {
  return log
    .filter((entry) => entry.store === 'bucket' && entry.method.startsWith('file.'))
    .map((entry) => ({ method: entry.method, target: entry.target }));
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

// ─── The invariant: the bytes are never absent from both locations ───────────

describe('Property 12: quarantine is reversible and never loses bytes', () => {
  it('keeps the bytes retrievable from the original path, the quarantine path, or both, under a failure at every step', async () => {
    await fc.assert(
      fc.asyncProperty(moveArb, async (move) => {
        const attempt = await attemptMove(move);
        const contents = attempt.bucket.contents();
        const stage = expectedStage(move);

        // ── Req 11.10, mid-flight ───────────────────────────────────────────
        // Every observation point saw the bytes somewhere. A mover that deleted
        // first and restored on failure would fail here while passing a
        // final-state-only assertion.
        expect(attempt.snapshots.length).toBeGreaterThan(0);
        for (const held of attempt.snapshots) expect(held.length).toBeGreaterThan(0);

        // ── Req 11.10, final state ─────────────────────────────────────────
        const atOriginal = contents.get(move.objectPath);
        const atQuarantine = contents.get(attempt.quarantinePath);
        expect(atOriginal !== undefined || atQuarantine !== undefined).toBe(true);

        // Whatever survives carries the source's bytes and its metadata bag, so a
        // "surviving" copy is a usable one rather than a placeholder.
        for (const survivor of [atOriginal, atQuarantine]) {
          if (survivor === undefined) continue;
          expect(survivor.size).toBe(move.size);
          expect(survivor.metadata).toEqual({ firebaseStorageDownloadTokens: move.token });
        }

        if (stage === null) {
          // ── The move succeeded ────────────────────────────────────────────
          expect(attempt.result).toMatchObject({ ok: true, quarantinePath: attempt.quarantinePath });
          expect(atQuarantine).toBeDefined();
          expect(atOriginal).toBeUndefined();
          // The destination is inside this tenant's quarantine namespace and is
          // exactly what the pure builder produces — never assembled by hand.
          expect(attempt.quarantinePath.startsWith(`${QUARANTINE_PREFIX}/${move.tenantId}/`)).toBe(
            true
          );
          return;
        }

        // ── The move failed at the generated step ────────────────────────────
        expect(attempt.result).toMatchObject({ ok: false, stage });
        const failure = attempt.result as { ok: false; message: string };
        expect(typeof failure.message).toBe('string');
        expect(failure.message.length).toBeGreaterThan(0);

        // Reqs 11.6, 11.7 and 11.8 all say the same thing about the original: it
        // is still there, and the next run will offer it again.
        expect(atOriginal).toBeDefined();
        // A failed copy leaves nothing behind at the destination; every later
        // failure leaves BOTH copies — an over-count the next recompute corrects.
        expect(atQuarantine === undefined).toBe(stage === 'copy');
      }),
      { numRuns: 100 }
    );
  });

  it('never deletes the original before a verified copy and a recorded manifest exist', async () => {
    await fc.assert(
      fc.asyncProperty(moveArb, async (move) => {
        const attempt = await attemptMove(move);
        const ops = bucketOps(attempt.log);

        const copyAt = ops.findIndex(
          (op) => op.method === 'file.copy' && op.target === move.objectPath
        );
        const verifyAt = ops.findIndex(
          (op) => op.method === 'file.getMetadata' && op.target === attempt.quarantinePath
        );
        const deleteAt = ops.findIndex(
          (op) => op.method === 'file.delete' && op.target === move.objectPath
        );
        const manifestAt = attempt.log.indexOf(
          (entry) => entry.store === 'firestore' && entry.target.includes('/quarantine/')
        );

        // The copy is always the first thing that happens to the object (Req 11.3).
        expect(copyAt).toBe(0);

        if (deleteAt === -1) {
          // No delete was attempted, which is required after a failed copy, a
          // failed or mismatched verify (Req 11.7) and a failed manifest write.
          expect(['copy', 'verify', 'manifest']).toContain(expectedStage(move));
          return;
        }

        // A delete was attempted, so the copy, the verify and the manifest all
        // preceded it — in that order (Reqs 11.3, 11.4, 11.5).
        expect(copyAt).toBeLessThan(deleteAt);
        expect(verifyAt).toBeGreaterThan(-1);
        expect(verifyAt).toBeLessThan(deleteAt);
        expect(manifestAt).toBeGreaterThan(-1);
        expect(
          attempt.log.indexOf((entry) => entry.method === 'file.delete')
        ).toBeGreaterThan(manifestAt);
        // Nothing is deleted twice, and no path other than the original is ever
        // the target of a delete in a move.
        expect(ops.filter((op) => op.method === 'file.delete')).toEqual([
          { method: 'file.delete', target: move.objectPath },
        ]);
      }),
      { numRuns: 100 }
    );
  });

  // ─── Restore is the exact inverse ──────────────────────────────────────────

  it('restores a successful move to exactly the original path with its download token intact', async () => {
    await fc.assert(
      fc.asyncProperty(
        moveArb.map((move) => ({ ...move, injection: 'none' as Injection })),
        async (move) => {
          const attempt = await attemptMove(move);
          expect(attempt.result).toMatchObject({ ok: true });

          const restored = await restoreFromQuarantine({
            bucket: attempt.bucket as unknown as SweepBucket,
            quarantinePath: attempt.quarantinePath,
            apply: true,
          });

          // EXACTLY the original path — not a normalised, re-encoded or otherwise
          // "tidied" variant of it (Req 11.11).
          expect(restored).toEqual({ restoredTo: move.objectPath });

          const back = attempt.bucket.contents().get(move.objectPath);
          expect(back).toBeDefined();
          expect(back!.size).toBe(move.size);
          // Req 11.12. The token is NOT re-minted, which is why the url already
          // stored on the owning record resolves again — and equally why
          // quarantine is not an access-revocation mechanism.
          expect(back!.metadata).toEqual({ firebaseStorageDownloadTokens: move.token });
          expect(attempt.bucket.contents().has(attempt.quarantinePath)).toBe(false);

          // The stored url, rebuilt from the surviving token, still maps back to
          // the restored object — the claim Req 11.12 is actually making.
          const storedUrl = buildFirebaseDownloadUrl(BUCKET_NAME, move.objectPath, move.token);
          expect(resolveBucketObjectPath(storedUrl, BUCKET_NAME)).toEqual({
            ok: true,
            objectPath: move.objectPath,
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('refuses an occupied destination and changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        moveArb.map((move) => ({ ...move, injection: 'none' as Injection })),
        fc.integer({ min: 1, max: 9_999 }),
        async (move, newerSize) => {
          const attempt = await attemptMove(move);
          expect(attempt.result).toMatchObject({ ok: true });

          // A later upload took the path. It is by definition the live object, and
          // recovering an older one by destroying it would be the actual loss.
          const newer: FakeObject = {
            name: move.objectPath,
            size: newerSize,
            timeCreated: iso(NOW),
            updated: iso(NOW),
            metadata: { firebaseStorageDownloadTokens: 'tok-newer' },
          };
          attempt.bucket.contents().set(move.objectPath, newer);
          attempt.log.clear();

          const refused = await restoreFromQuarantine({
            bucket: attempt.bucket as unknown as SweepBucket,
            quarantinePath: attempt.quarantinePath,
            apply: true,
          });

          expect(refused).toEqual({ error: 'destination_occupied' });
          // Existence was checked, and nothing else was attempted.
          expect(attempt.log.writes()).toEqual([]);
          expect(bucketOps(attempt.log)).toEqual([
            { method: 'file.exists', target: move.objectPath },
          ]);
          // Both objects are exactly as they were.
          expect(attempt.bucket.contents().get(move.objectPath)).toEqual(newer);
          expect(attempt.bucket.contents().get(attempt.quarantinePath)).toMatchObject({
            size: move.size,
            metadata: { firebaseStorageDownloadTokens: move.token },
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
