/**
 * Unit coverage for the two mutating stage-2 functions (spec tasks 8.1 and 8.2).
 *
 * `quarantineObject` is asserted over the ORDER of the operations it performs and
 * over what survives each individual failure, because that is what the
 * requirement actually says: copy → verify → manifest → delete, and at every
 * point the bytes are readable from the original path, the quarantine path, or
 * both. The single chronological operation log from the shared harness makes each
 * of those claims a statement about the relative position of two entries in one
 * list rather than an inference from an outcome.
 *
 * `restoreFromQuarantine` is asserted over its two refusals and over the exactness
 * of the path it recreates — including that the download token survives, which is
 * the whole reason restore is a recovery rather than a byte-level curiosity.
 *
 * Task 9.2 extended this file with `purgeExpiredQuarantine`, the irreversible
 * stage, at the bottom.
 */

import { DAY_MS } from '../lib/orphanDecision';
import { QUARANTINE_PREFIX, TenantScopeViolation } from '../lib/storageObjectRef';
import {
  purgeExpiredQuarantine,
  quarantineManifestPath,
  quarantineObject,
  restoreFromQuarantine,
  runStorageOrphanSweep,
  tenantReportPath,
  type SweepBucket,
} from '../jobs/storageOrphanSweep';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  downloadUrl,
  iso,
  sweepConfig,
  type FakeBucket,
  type FakeObject,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const SWEEP_ID = 'sweep_test_0001';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const OLD = iso(NOW - 400 * DAY_MS);

const OBJECT_PATH = `receipts/${TENANT}/fee_77/k_aa11_march.pdf`;
const QUARANTINE_PATH = `_orphan-quarantine/${TENANT}/${SWEEP_ID}/${OBJECT_PATH}`;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bucketOperations(log: OperationLog): string[] {
  return log
    .filter((entry) => entry.store === 'bucket' && entry.method.startsWith('file.'))
    .map((entry) => `${entry.method} ${entry.target}`);
}

function manifestWriteIndex(log: OperationLog): number {
  return log.indexOf(
    (entry) => entry.store === 'firestore' && entry.target.includes('/quarantine/')
  );
}

interface Harness {
  log: OperationLog;
  bucket: FakeBucket;
  db: ReturnType<typeof createFakeFirestore>;
}

function harness(
  objects: FakeObject[],
  overrides: Partial<Parameters<typeof createFakeBucket>[0]> = {},
  writeFailures?: Record<string, unknown>
): Harness {
  const log = createOperationLog();
  return {
    log,
    bucket: createFakeBucket({ log, objects, ...overrides }),
    db: createFakeFirestore({ log, writeFailures }),
  };
}

const receipt: FakeObject = {
  name: OBJECT_PATH,
  size: 4_096,
  timeCreated: OLD,
  updated: OLD,
  metadata: { firebaseStorageDownloadTokens: 'tok-original' },
};

function move(h: Harness, extra: Record<string, unknown> = {}) {
  return quarantineObject({
    bucket: h.bucket as unknown as SweepBucket,
    db: h.db as never,
    tenantId: TENANT,
    sweepId: SWEEP_ID,
    objectPath: OBJECT_PATH,
    bytes: receipt.size,
    quarantineRetentionDays: 7,
    nowMs: NOW,
    ...extra,
  });
}

// ─── quarantineObject: the happy path and its ordering ───────────────────────

describe('quarantineObject: copy → verify → manifest → delete', () => {
  it('performs the four steps in exactly that order and leaves a verified copy', async () => {
    const h = harness([receipt]);

    const result = await move(h);

    expect(result).toMatchObject({ ok: true, bytes: 4_096, quarantinePath: QUARANTINE_PATH });

    // The order, read straight off the log rather than inferred.
    expect(bucketOperations(h.log)).toEqual([
      `file.copy ${OBJECT_PATH}`,
      `file.getMetadata ${QUARANTINE_PATH}`,
      `file.delete ${OBJECT_PATH}`,
    ]);

    // The manifest lands between the verify and the delete (Req 11.5).
    const verifyAt = h.log.indexOf((entry) => entry.method === 'file.getMetadata');
    const deleteAt = h.log.indexOf((entry) => entry.method === 'file.delete');
    const manifestAt = manifestWriteIndex(h.log);
    expect(manifestAt).toBeGreaterThan(verifyAt);
    expect(manifestAt).toBeLessThan(deleteAt);

    // The bucket: original gone, verified copy under the tenant's sweep folder.
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(false);
    expect(h.bucket.contents().get(QUARANTINE_PATH)).toMatchObject({ size: 4_096 });
  });

  it('records the manifest entry the restore path and the report need', async () => {
    const h = harness([receipt]);

    await move(h);

    const path = quarantineManifestPath(TENANT, SWEEP_ID, OBJECT_PATH);
    expect(path.startsWith(`${tenantReportPath(TENANT)}/quarantine/`)).toBe(true);
    // The client-supplied filename is hashed, never embedded in the document id.
    expect(path).not.toContain('march.pdf');

    const entry = h.db.read(path);
    expect(entry).toMatchObject({
      tenantId: TENANT,
      sweepId: SWEEP_ID,
      objectPath: OBJECT_PATH,
      quarantinePath: QUARANTINE_PATH,
      bytes: 4_096,
    });
    expect((entry!.movedAt as Date).getTime()).toBe(NOW);
    expect((entry!.retainedUntil as Date).getTime()).toBe(NOW + 7 * DAY_MS);
  });

  it('defaults the retention window to seven days', async () => {
    const h = harness([receipt]);

    await move(h, { quarantineRetentionDays: undefined });

    const entry = h.db.read(quarantineManifestPath(TENANT, SWEEP_ID, OBJECT_PATH))!;
    expect((entry.retainedUntil as Date).getTime()).toBe(NOW + 7 * DAY_MS);
  });

  it('places a second run of the same path under a distinct sweepId folder', async () => {
    const h = harness([receipt]);

    await move(h);
    // The next run re-lists the original only if the delete failed; here the
    // object is re-created to stand in for "the same path quarantined twice".
    h.bucket.contents().set(OBJECT_PATH, { ...receipt });
    const second = await move(h, { sweepId: 'sweep_test_0002' });

    expect(second).toMatchObject({ ok: true });
    expect(h.bucket.contents().has(QUARANTINE_PATH)).toBe(true);
    expect(
      h.bucket.contents().has(`_orphan-quarantine/${TENANT}/sweep_test_0002/${OBJECT_PATH}`)
    ).toBe(true);
  });
});

// ─── quarantineObject: every failure mode ────────────────────────────────────

describe('quarantineObject: each failure leaves the bytes retrievable', () => {
  it('a failed copy leaves the original untouched and never deletes', async () => {
    const h = harness([receipt], { failCopy: () => new Error('copy denied') });

    const result = await move(h);

    expect(result).toMatchObject({ ok: false, stage: 'copy', message: 'copy denied' });
    expect(bucketOperations(h.log)).toEqual([`file.copy ${OBJECT_PATH}`]);
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
    expect(manifestWriteIndex(h.log)).toBe(-1);
  });

  it('an unverifiable copy aborts before the delete', async () => {
    const h = harness([receipt], {
      failGetMetadata: (path) => (path === QUARANTINE_PATH ? new Error('metadata unavailable') : undefined),
    });

    const result = await move(h);

    expect(result).toMatchObject({ ok: false, stage: 'verify' });
    expect(bucketOperations(h.log)).toEqual([
      `file.copy ${OBJECT_PATH}`,
      `file.getMetadata ${QUARANTINE_PATH}`,
    ]);
    // Both copies exist: an over-count, never a loss.
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
    expect(h.bucket.contents().has(QUARANTINE_PATH)).toBe(true);
    expect(manifestWriteIndex(h.log)).toBe(-1);
  });

  it('a size mismatch aborts before the delete — a copy that differs is not a copy', async () => {
    const h = harness([receipt], {
      metadataSizeOverride: (path) => (path === QUARANTINE_PATH ? 4_095 : undefined),
    });

    const result = await move(h);

    expect(result).toMatchObject({ ok: false, stage: 'verify' });
    expect((result as { message: string }).message).toContain('4096');
    expect(h.log.filter((entry) => entry.method === 'file.delete')).toEqual([]);
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
  });

  it('treats destination metadata with no readable size as unverified when a size was expected', async () => {
    const h = harness([{ ...receipt }], {
      metadataSizeOverride: (path) => (path === QUARANTINE_PATH ? Number.NaN : undefined),
    });

    const result = await move(h);

    expect(result).toMatchObject({ ok: false, stage: 'verify' });
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
  });

  it('a failed manifest write skips the delete', async () => {
    const manifest = quarantineManifestPath(TENANT, SWEEP_ID, OBJECT_PATH);
    const h = harness([receipt], {}, { [manifest]: new Error('firestore unavailable') });

    const result = await move(h);

    expect(result).toMatchObject({ ok: false, stage: 'manifest', message: 'firestore unavailable' });
    expect(h.log.filter((entry) => entry.method === 'file.delete')).toEqual([]);
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
    expect(h.bucket.contents().has(QUARANTINE_PATH)).toBe(true);
  });

  it('a failed delete leaves BOTH copies in place', async () => {
    const h = harness([receipt], { failDelete: () => new Error('delete denied') });

    const result = await move(h);

    expect(result).toMatchObject({ ok: false, stage: 'delete', message: 'delete denied' });
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
    expect(h.bucket.contents().has(QUARANTINE_PATH)).toBe(true);
    // The manifest was still recorded first, so the copy is discoverable.
    expect(manifestWriteIndex(h.log)).toBeGreaterThan(-1);
  });

  it('verifies against the source size even when the copy is byte-identical', async () => {
    const h = harness([receipt]);

    // `bytes: null` — the listing could not read a size, so the SOURCE's own size is
    // read at move time and the copy is compared against that. There is still a
    // size comparison; it is never existence alone.
    const result = await move(h, { bytes: null });

    expect(result).toMatchObject({ ok: true, bytes: 4_096 });
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(false);
    // The extra read that makes the comparison possible.
    expect(bucketOperations(h.log)).toContain(`file.getMetadata ${OBJECT_PATH}`);
  });

  /**
   * ── The one branch on which "verify" could have meant "exists" ─────────────
   *
   * `bytes` is the LISTING's size and is documented as reporting-only, so
   * `parseObjectBytes` returning `null` for it must not weaken the gate that stands
   * immediately before an irreversible delete. Reading a `null` size out of a real
   * `bucket.getFiles()` page is not reachable today — the JSON API always returns
   * `size` for a finalized object — but the value arrives through the same
   * untrusted-parse path as every other read value, and the consequence of the
   * `null` branch skipping the comparison is the permanent loss of a truncated
   * object's bytes. So the comparison is made total: with no listing size, the
   * source's live size is read and compared, and a size that cannot be established
   * on EITHER side is a verify failure.
   */
  it('refuses the move when the listing had no size and the copy differs from the source', async () => {
    const h = harness([receipt], {
      // A copy that landed at the right path with the wrong bytes — the one failure
      // a fake that simply mirrors the source cannot otherwise produce.
      metadataSizeOverride: (path) => (path === QUARANTINE_PATH ? 0 : undefined),
    });

    const result = await move(h, { bytes: null });

    expect(result).toMatchObject({ ok: false, stage: 'verify' });
    expect((result as { message: string }).message).toContain('4096');
    // The original is still readable and nothing was deleted.
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
    expect(h.log.filter((entry) => entry.method === 'file.delete')).toEqual([]);
    expect(manifestWriteIndex(h.log)).toBe(-1);
  });

  it('refuses the move when neither the listing nor the source yields a size', async () => {
    const h = harness([receipt], {
      // Unreadable on both sides: the copy's size and the source's size.
      metadataSizeOverride: () => Number.NaN,
    });

    const result = await move(h, { bytes: null });

    expect(result).toMatchObject({ ok: false, stage: 'verify' });
    expect((result as { message: string }).message).toMatch(/size/i);
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
    expect(h.log.filter((entry) => entry.method === 'file.delete')).toEqual([]);
  });

  it('refuses the move when the listing had no size and the source metadata read fails', async () => {
    const h = harness([receipt], {
      failGetMetadata: (path) => (path === OBJECT_PATH ? new Error('source metadata unavailable') : undefined),
    });

    const result = await move(h, { bytes: null });

    expect(result).toMatchObject({ ok: false, stage: 'verify' });
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(true);
    expect(h.log.filter((entry) => entry.method === 'file.delete')).toEqual([]);
  });
});

// ─── quarantineObject: the guard ─────────────────────────────────────────────

describe('quarantineObject: guard 2 of 3', () => {
  it('throws a non-retryable TenantScopeViolation for another tenant’s path, touching nothing', async () => {
    const h = harness([{ name: `receipts/acme-2/x.pdf`, size: 10 }]);

    const attempt = quarantineObject({
      bucket: h.bucket as unknown as SweepBucket,
      db: h.db as never,
      tenantId: TENANT,
      sweepId: SWEEP_ID,
      objectPath: 'receipts/acme-2/x.pdf',
      bytes: 10,
      nowMs: NOW,
    });

    await expect(attempt).rejects.toBeInstanceOf(TenantScopeViolation);
    await expect(attempt).rejects.toMatchObject({ retryable: false, reason: 'tenant_mismatch' });
    // Not one bucket or Firestore call was attempted.
    expect(h.log.entries).toEqual([]);
  });

  it('rejects a path outside the managed categories', async () => {
    const h = harness([]);

    await expect(
      quarantineObject({
        bucket: h.bucket as unknown as SweepBucket,
        db: h.db as never,
        tenantId: TENANT,
        sweepId: SWEEP_ID,
        objectPath: `_orphan-quarantine/${TENANT}/${SWEEP_ID}/receipts/${TENANT}/x.pdf`,
        bytes: 10,
        nowMs: NOW,
      })
    ).rejects.toBeInstanceOf(TenantScopeViolation);
    expect(h.log.entries).toEqual([]);
  });

  it('refuses a bucket that exposes no file() handle rather than reporting a phantom move', async () => {
    const log = createOperationLog();
    const listingOnly: SweepBucket = { name: 'b', getFiles: async () => [[], null, {}] };

    await expect(
      quarantineObject({
        bucket: listingOnly,
        db: createFakeFirestore({ log }) as never,
        tenantId: TENANT,
        sweepId: SWEEP_ID,
        objectPath: OBJECT_PATH,
        bytes: 1,
        nowMs: NOW,
      })
    ).rejects.toThrow(/no file\(\) handle/);
  });
});

// ─── restoreFromQuarantine ───────────────────────────────────────────────────

describe('restoreFromQuarantine: the exact inverse', () => {
  it('refuses a path that is not a well-formed quarantine path, touching nothing', async () => {
    const h = harness([receipt]);

    for (const path of [
      OBJECT_PATH,
      '_orphan-quarantine/acme',
      `_orphan-quarantine/${TENANT}/${SWEEP_ID}`,
      '',
    ]) {
      expect(
        await restoreFromQuarantine({
          bucket: h.bucket as unknown as SweepBucket,
          quarantinePath: path,
          apply: true,
        })
      ).toEqual({ error: 'not_a_quarantine_path' });
    }
    expect(h.log.entries).toEqual([]);
  });

  it('refuses an occupied destination and changes nothing', async () => {
    const h = harness([
      receipt,
      { name: QUARANTINE_PATH, size: 4_096, metadata: { firebaseStorageDownloadTokens: 'tok-old' } },
    ]);

    const result = await restoreFromQuarantine({
      bucket: h.bucket as unknown as SweepBucket,
      quarantinePath: QUARANTINE_PATH,
      apply: true,
    });

    expect(result).toEqual({ error: 'destination_occupied' });
    // Existence was checked and nothing else. A newer object at the path is the
    // live one; overwriting it to recover an older one would be the loss.
    expect(bucketOperations(h.log)).toEqual([`file.exists ${OBJECT_PATH}`]);
    expect(h.bucket.contents().get(OBJECT_PATH)!.metadata).toEqual({
      firebaseStorageDownloadTokens: 'tok-original',
    });
  });

  it('reports the intended destination without changing anything when apply is false', async () => {
    const h = harness([{ name: QUARANTINE_PATH, size: 4_096 }]);

    const result = await restoreFromQuarantine({
      bucket: h.bucket as unknown as SweepBucket,
      quarantinePath: QUARANTINE_PATH,
      apply: false,
    });

    expect(result).toEqual({ restoredTo: OBJECT_PATH });
    expect(h.log.writes()).toEqual([]);
    expect(h.bucket.contents().has(OBJECT_PATH)).toBe(false);
    expect(h.bucket.contents().has(QUARANTINE_PATH)).toBe(true);
  });

  it('restores to exactly the original path with the download token intact', async () => {
    const h = harness([receipt]);

    const moved = await move(h);
    expect(moved).toMatchObject({ ok: true });
    h.log.clear();

    const restored = await restoreFromQuarantine({
      bucket: h.bucket as unknown as SweepBucket,
      quarantinePath: QUARANTINE_PATH,
      apply: true,
    });

    expect(restored).toEqual({ restoredTo: OBJECT_PATH });
    expect(bucketOperations(h.log)).toEqual([
      `file.exists ${OBJECT_PATH}`,
      `file.copy ${QUARANTINE_PATH}`,
      `file.delete ${QUARANTINE_PATH}`,
    ]);

    const back = h.bucket.contents().get(OBJECT_PATH);
    expect(back).toBeDefined();
    expect(back!.size).toBe(4_096);
    // The token survives the round trip, which is what makes the url already
    // stored on the owning record resolve again — and why quarantine is NOT an
    // access-revocation mechanism.
    expect(back!.metadata).toEqual({ firebaseStorageDownloadTokens: 'tok-original' });
    expect(h.bucket.contents().has(QUARANTINE_PATH)).toBe(false);
  });
});

// ─── The apply-mode wiring ───────────────────────────────────────────────────

describe('the listing loop drives the real mover', () => {
  const orphan = `notices/${TENANT}/gone.png`;

  function applyFixture(objects: FakeObject[]) {
    const log = createOperationLog();
    return {
      log,
      bucket: createFakeBucket({ log, objects }),
      db: createFakeFirestore({ log, collections: { notices: {}, fees: {} } }),
      rtdb: createFakeRtdb({ log, tree: {} }),
    };
  }

  it('copies before deleting every object and writes each manifest entry first', async () => {
    const f = applyFixture([
      { name: orphan, size: 64, timeCreated: OLD, updated: OLD },
      { name: `notices/${TENANT}/also-gone.png`, size: 32, timeCreated: OLD, updated: OLD },
    ]);

    const run = await runStorageOrphanSweep({
      db: f.db as never,
      rtdb: f.rtdb as never,
      bucket: f.bucket as never,
      config: sweepConfig({ mode: 'sweep', apply: true, nowMs: NOW, sweepId: SWEEP_ID }) as never,
      quarantineObject,
    });

    const [result] = run.tenants;
    expect(run.dryRun).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.orphanCount).toBe(2);
    expect(result.quarantinedCount).toBe(2);
    expect(result.quarantineFailures).toBe(0);
    expect(result.quarantinedBytes).toBe(96);

    for (const path of [orphan, `notices/${TENANT}/also-gone.png`]) {
      const copyAt = f.log.indexOf((e) => e.method === 'file.copy' && e.target === path);
      const deleteAt = f.log.indexOf((e) => e.method === 'file.delete' && e.target === path);
      const manifestAt = f.log.indexOf(
        (e) => e.store === 'firestore' && e.target === quarantineManifestPath(TENANT, SWEEP_ID, path)
      );
      expect(copyAt).toBeGreaterThan(-1);
      expect(copyAt).toBeLessThan(manifestAt);
      expect(manifestAt).toBeLessThan(deleteAt);
      expect(f.bucket.contents().has(path)).toBe(false);
      expect(
        f.bucket.contents().has(`_orphan-quarantine/${TENANT}/${SWEEP_ID}/${path}`)
      ).toBe(true);
    }
  });

  it('never moves a referenced object', async () => {
    const kept = `notices/${TENANT}/kept.png`;
    const f = applyFixture([
      { name: kept, size: 8, timeCreated: OLD, updated: OLD },
      { name: orphan, size: 64, timeCreated: OLD, updated: OLD },
    ]);
    f.db.documents.set('notices/n1', { tenantId: TENANT, imageUrl: downloadUrl(kept) });

    const run = await runStorageOrphanSweep({
      db: f.db as never,
      rtdb: f.rtdb as never,
      bucket: f.bucket as never,
      config: sweepConfig({ mode: 'sweep', apply: true, nowMs: NOW, sweepId: SWEEP_ID }) as never,
      quarantineObject,
    });

    expect(run.tenants[0].quarantinedCount).toBe(1);
    expect(f.log.filter((e) => e.method === 'file.copy').map((e) => e.target)).toEqual([orphan]);
    expect(f.bucket.contents().has(kept)).toBe(true);
  });

  it('ends the tenant’s run with tenant_scope_violation when the guard fires at the move', async () => {
    const f = applyFixture([{ name: orphan, size: 64, timeCreated: OLD, updated: OLD }]);

    const run = await runStorageOrphanSweep({
      db: f.db as never,
      rtdb: f.rtdb as never,
      bucket: f.bucket as never,
      config: sweepConfig({ mode: 'sweep', apply: true, nowMs: NOW, sweepId: SWEEP_ID }) as never,
      // The guard is unreachable through the Decision_Function, so the violation is
      // injected: what is under test is that the loop ABORTS the tenant rather than
      // counting a failure and moving on (Req 4.9).
      quarantineObject: async () => {
        throw new TenantScopeViolation(orphan, 'other', 'tenant_mismatch');
      },
    });

    const [result] = run.tenants;
    expect(result.status).toBe('aborted');
    expect(result.abortReason).toBe('tenant_scope_violation');
    expect(result.quarantinedCount).toBe(0);
    expect(result.quarantineFailures).toBe(0);
    expect(f.bucket.contents().has(orphan)).toBe(true);

    const report = f.db.read(tenantReportPath(TENANT))!;
    expect(report.abortReason).toBe('tenant_scope_violation');
  });

  it('stops at the per-tenant ceiling with a resume cursor and a deliberate abort', async () => {
    const objects: FakeObject[] = Array.from({ length: 5 }, (_, index) => ({
      name: `notices/${TENANT}/orphan_${index}.png`,
      size: 10,
      timeCreated: OLD,
      updated: OLD,
    }));
    const f = applyFixture(objects);

    const run = await runStorageOrphanSweep({
      db: f.db as never,
      rtdb: f.rtdb as never,
      bucket: f.bucket as never,
      config: sweepConfig({
        mode: 'sweep',
        apply: true,
        nowMs: NOW,
        sweepId: SWEEP_ID,
        maxQuarantinePerTenant: 2,
      }) as never,
      quarantineObject,
    });

    const [result] = run.tenants;
    expect(result.status).toBe('aborted');
    expect(result.abortReason).toBe('quarantine_cap_reached');
    expect(result.quarantinedCount).toBe(2);

    const report = f.db.read(tenantReportPath(TENANT))!;
    expect(report.resume).toMatchObject({ prefixIndex: expect.any(Number) });
    expect(f.log.filter((e) => e.method === 'file.copy').length).toBe(2);
  });

  it('counts a failed move as a failure and continues with the next candidate', async () => {
    const objects: FakeObject[] = ['a', 'b', 'c'].map((slug) => ({
      name: `notices/${TENANT}/orphan_${slug}.png`,
      size: 10,
      timeCreated: OLD,
      updated: OLD,
    }));
    const log = createOperationLog();
    const bucket = createFakeBucket({
      log,
      objects,
      failCopy: (path) => (path.endsWith('orphan_b.png') ? new Error('copy denied') : undefined),
    });

    const run = await runStorageOrphanSweep({
      db: createFakeFirestore({ log, collections: { notices: {} } }) as never,
      rtdb: createFakeRtdb({ log, tree: {} }) as never,
      bucket: bucket as never,
      config: sweepConfig({ mode: 'sweep', apply: true, nowMs: NOW, sweepId: SWEEP_ID }) as never,
      quarantineObject,
    });

    const [result] = run.tenants;
    expect(result.status).toBe('completed');
    expect(result.orphanCount).toBe(3);
    expect(result.quarantinedCount).toBe(2);
    expect(result.quarantineFailures).toBe(1);
    expect(result.quarantinedCount + result.quarantineFailures).toBeLessThanOrEqual(
      result.orphanCount
    );
    // The one that failed is still there, retrievable, and will be offered again.
    expect(bucket.contents().has(`notices/${TENANT}/orphan_b.png`)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// purgeExpiredQuarantine — the irreversible stage (spec task 9.2)
// ═════════════════════════════════════════════════════════════════════════════
//
// The structural claim — that no live object path is in this function's delete
// domain — is asserted twice elsewhere and is not re-asserted here: over generated
// input in `storageObjectRef.quarantineDomain.property.test.ts` (Property 8), and
// end to end by injecting a live object into the purge listing in
// `storageOrphanSweep.integration.test.ts`. What is asserted below is everything
// the domain argument does NOT cover: the age gate on both sides of its boundary,
// the `age_unknown` retention, the Scope_Guard on the reconstructed original path,
// the dry run, the page walk, and a delete failure not stranding the rest.

/** A quarantined copy of `objectPath`, last touched `ageMs` before `NOW`. */
function quarantined(objectPath: string, ageMs: number | null, size = 100): FakeObject {
  const name = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${objectPath}`;
  // Omitting BOTH timestamps is how the fake makes an age unreadable.
  return ageMs === null
    ? { name, size }
    : { name, size, timeCreated: iso(NOW - ageMs), updated: iso(NOW - ageMs) };
}

function purge(bucket: FakeBucket, overrides: Record<string, unknown> = {}) {
  return purgeExpiredQuarantine({
    bucket: bucket as unknown as SweepBucket,
    purgeEnabled: true,
    apply: true,
    retentionDays: 7,
    nowMs: NOW,
    ...overrides,
  });
}

describe('purgeExpiredQuarantine: both switches default off', () => {
  it('examines nothing at all unless the purge switch is explicitly true', async () => {
    const h = harness([quarantined(OBJECT_PATH, 400 * DAY_MS)]);

    const result = await purgeExpiredQuarantine({
      bucket: h.bucket as unknown as SweepBucket,
      // No `purgeEnabled`, no `apply`, no retention: every default is the safe one.
      nowMs: NOW,
    });

    expect(result).toMatchObject({
      enabled: false,
      applied: false,
      retentionDays: 7,
      examined: 0,
      deleteEligible: 0,
      deleted: 0,
      pagesListed: 0,
    });
    // Not even a listing: the switch is checked before the first read.
    expect(h.bucket.getFilesCalls).toEqual([]);
    expect(h.log.entries).toEqual([]);
  });

  it('falls back to the documented seven days rather than to zero', async () => {
    const h = harness([quarantined(OBJECT_PATH, 3 * DAY_MS)]);

    // A retention of `0` would purge everything the moment it was quarantined.
    const result = await purge(h.bucket, { retentionDays: 0, apply: false });

    expect(result.retentionDays).toBe(7);
    expect(result.retentionCutoffMs).toBe(NOW - 7 * DAY_MS);
    expect(result.deleteEligible).toBe(0);
    expect(result.retainedByReason.within_retention).toBe(1);
  });

  it('refuses a bucket that exposes no file() handle rather than reporting a phantom purge', async () => {
    const listingOnly: SweepBucket = { name: 'b', getFiles: async () => [[], null, {}] };

    await expect(
      purgeExpiredQuarantine({ bucket: listingOnly, purgeEnabled: true, apply: true, nowMs: NOW })
    ).rejects.toThrow(/file\(\) handle/);

    // The dry run needs no handle, so it is allowed through.
    await expect(
      purgeExpiredQuarantine({ bucket: listingOnly, purgeEnabled: true, apply: false, nowMs: NOW })
    ).resolves.toMatchObject({ enabled: true, applied: false, examined: 0 });
  });
});

describe('purgeExpiredQuarantine: the age gate', () => {
  const past = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/receipts/${TENANT}/fee_1/past.pdf`;
  const exactly = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/receipts/${TENANT}/fee_2/exactly.pdf`;
  const inside = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/receipts/${TENANT}/fee_3/inside.pdf`;

  it('deletes one millisecond past the window and retains one exactly at it', async () => {
    const h = harness([
      quarantined(`receipts/${TENANT}/fee_1/past.pdf`, 7 * DAY_MS + 1, 10),
      quarantined(`receipts/${TENANT}/fee_2/exactly.pdf`, 7 * DAY_MS, 20),
      quarantined(`receipts/${TENANT}/fee_3/inside.pdf`, 7 * DAY_MS - 1, 40),
    ]);

    const result = await purge(h.bucket);

    expect(result).toMatchObject({
      enabled: true,
      applied: true,
      examined: 3,
      deleteEligible: 1,
      deleteEligibleBytes: 10,
      deleted: 1,
      deletedBytes: 10,
      retained: 2,
      retainedBytes: 60,
      failures: 0,
    });
    // The comparison is strict, so the boundary itself retains — the same
    // direction `decideObjectDisposition` takes at the grace cutoff.
    expect(result.retainedByReason.within_retention).toBe(2);
    expect(bucketOperations(h.log)).toEqual([`file.delete ${past}`]);
    expect(h.bucket.contents().has(past)).toBe(false);
    expect(h.bucket.contents().has(exactly)).toBe(true);
    expect(h.bucket.contents().has(inside)).toBe(true);
  });

  it('retains an object whose age cannot be determined', async () => {
    const undated = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${OBJECT_PATH}`;
    const h = harness([
      quarantined(OBJECT_PATH, null, 64),
      quarantined(`notices/${TENANT}/aged.png`, 400 * DAY_MS, 8),
    ]);

    const result = await purge(h.bucket);

    expect(result.examined).toBe(2);
    expect(result.retainedByReason.age_unknown).toBe(1);
    expect(result.deleteEligible).toBe(1);
    expect(result.deleted).toBe(1);
    // Unprovable age ⇒ retained, matching `decideObjectDisposition`'s posture: an
    // age we cannot read is not an age we can use to prove anything.
    expect(h.bucket.contents().has(undated)).toBe(true);
    expect(bucketOperations(h.log)).toEqual([
      `file.delete ${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/notices/${TENANT}/aged.png`,
    ]);
  });

  it('refuses a well-formed quarantine path whose original path fails the Scope_Guard', async () => {
    // Guard 3 of 3 applies to the RECONSTRUCTED original path (Req 4.5). Both
    // shapes below parse as quarantine paths and neither is deletable: one
    // reconstructs to a path too shallow to be a managed object, the other to
    // another tenant's object sitting in this tenant's folder.
    const shallow = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/etc/passwd`;
    const crossTenant = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/receipts/acme-2/x.pdf`;
    const h = harness([
      { name: shallow, size: 1, timeCreated: OLD, updated: OLD },
      { name: crossTenant, size: 2, timeCreated: OLD, updated: OLD },
    ]);

    const result = await purge(h.bucket);

    expect(result.examined).toBe(2);
    expect(result.retainedByReason.tenant_scope_violation).toBe(2);
    expect(result.deleteEligible).toBe(0);
    expect(result.deleted).toBe(0);
    expect(bucketOperations(h.log)).toEqual([]);
    expect(h.bucket.contents().has(shallow)).toBe(true);
    expect(h.bucket.contents().has(crossTenant)).toBe(true);
  });
});

describe('purgeExpiredQuarantine: the dry run and the walk', () => {
  it('counts examined, delete-eligible and retained without deleting anything', async () => {
    const aged = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/${OBJECT_PATH}`;
    const h = harness([
      quarantined(OBJECT_PATH, 400 * DAY_MS, 4_096),
      quarantined(`notices/${TENANT}/fresh.png`, 1 * DAY_MS, 16),
      quarantined(`notices/${TENANT}/undated.png`, null, 32),
    ]);

    const result = await purge(h.bucket, { apply: false });

    expect(result).toMatchObject({
      enabled: true,
      applied: false,
      examined: 3,
      deleteEligible: 1,
      deleteEligibleBytes: 4_096,
      deleted: 0,
      deletedBytes: 0,
      retained: 2,
      failures: 0,
    });
    expect(result.retainedByReason).toMatchObject({ within_retention: 1, age_unknown: 1 });
    // Not one bucket mutator, and not even a `file()` handle for the eligible one.
    expect(h.log.writes()).toEqual([]);
    expect(bucketOperations(h.log)).toEqual([]);
    expect(h.bucket.contents().size).toBe(3);
    expect(h.bucket.contents().has(aged)).toBe(true);
  });

  it('walks the whole prefix by page token rather than materialising it', async () => {
    const objects = Array.from({ length: 5 }, (_, index) =>
      quarantined(`notices/${TENANT}/orphan_${index}.png`, 400 * DAY_MS, 10)
    );
    const h = harness(objects);

    const result = await purge(h.bucket, { pageSize: 2 });

    expect(result).toMatchObject({
      examined: 5,
      deleteEligible: 5,
      deleted: 5,
      deletedBytes: 50,
      retained: 0,
      pagesListed: 3,
    });
    // One listing per page, each scoped to the single quarantine prefix and each
    // capped at the page size — never `autoPaginate`.
    expect(h.bucket.getFilesCalls.length).toBe(3);
    for (const call of h.bucket.getFilesCalls) {
      expect(call.prefix).toBe(`${QUARANTINE_PREFIX}/`);
      expect(call.maxResults).toBe(2);
      expect(call.autoPaginate).toBe(false);
    }
    // The second and third pages continued from a token rather than restarting.
    expect(h.bucket.getFilesCalls[0].pageToken).toBeUndefined();
    expect(h.bucket.getFilesCalls[1].pageToken).toBeDefined();
    expect(h.bucket.getFilesCalls[2].pageToken).toBeDefined();
    expect([...h.bucket.contents().keys()]).toEqual([]);
  });

  it('counts a delete failure and continues the walk', async () => {
    const objects = ['a', 'b', 'c'].map((slug) =>
      quarantined(`notices/${TENANT}/orphan_${slug}.png`, 400 * DAY_MS, 10)
    );
    const stubborn = `${QUARANTINE_PREFIX}/${TENANT}/${SWEEP_ID}/notices/${TENANT}/orphan_b.png`;
    const h = harness(objects, {
      failDelete: (path) => (path === stubborn ? new Error('delete denied') : undefined),
    });

    const result = await purge(h.bucket, { pageSize: 1 });

    expect(result).toMatchObject({
      examined: 3,
      deleteEligible: 3,
      deleted: 2,
      deletedBytes: 20,
      failures: 1,
      retained: 0,
      pagesListed: 3,
    });
    // The undeletable object must not strand the objects behind it: all three were
    // attempted, and the two that could go are gone.
    expect(bucketOperations(h.log).filter((entry) => entry.startsWith('file.delete')).length).toBe(3);
    expect([...h.bucket.contents().keys()]).toEqual([stubborn]);
  });
});
