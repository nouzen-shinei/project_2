/**
 * Device Tenant Index backfill — core module (Stage 4 of the
 * `device-tenant-index` feature; design Component 7).
 *
 * A re-runnable, idempotent, batched, resumable sweep that populates the
 * denormalized per-device `tenantIndex` for pre-existing `user_devices/{email}/
 * devices/{id}` documents so the scoped `collectionGroup('devices')
 * .where('tenantIndex','array-contains', t)` listing becomes usable on
 * production data with no downtime (Requirement 4).
 *
 * Design contract:
 *   - Reads/writes durable {@link Backfill_Progress} at
 *     {@link DEVICE_TENANT_INDEX_BACKFILL_PROGRESS_PATH}. When
 *     `status === 'completed'` and `force` is not set, the run is an idempotent
 *     no-op (Req 4.8).
 *   - Pages the collection group ordered by document id
 *     (`FieldPath.documentId()`), resuming from the persisted `resumeCursor`
 *     when present, so pagination is stable and resumable across restarts
 *     (Req 4.2, 4.4).
 *   - For each device computes {@link deriveTenantIndex}; SKIPS the write when
 *     the stored `tenantIndex` already deep-equals the derived value (both are
 *     canonical sorted arrays), else stages `batch.update(ref, { tenantIndex })`
 *     (Req 4.1, 4.5, 4.8).
 *   - Commits the {@link admin.firestore.WriteBatch} (only changed docs), THEN
 *     persists progress (`processedCount`, `updatedCount`, `resumeCursor =
 *     lastDoc.ref.path`, `updatedAt`). Persisting only AFTER the data commit
 *     means a mid-run failure leaves the last successful cursor intact
 *     (partial-failure retention — Req 4.3, 4.6).
 *   - Marks `status: 'completed'` + `completedAt` when a page returns fewer than
 *     `batchSize` docs (end of the collection group reached — Req 4.9).
 *   - Clamps the batch size to <= 500 (the Firestore batched-write limit) and
 *     records `lastError` (retaining prior progress) on failure.
 *
 * This module performs I/O; the per-device convergence decision it relies on
 * ({@link deriveTenantIndex} + the skip-when-correct equality) is pure and
 * property-tested.
 */

import * as admin from 'firebase-admin';

import {
  deriveTenantIndex,
  DEVICE_TENANT_INDEX_BACKFILL_PROGRESS_PATH,
  type TenantScopedDevice,
} from '../deviceAdminService';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';

/** Default backfill batch size when none / an invalid one is configured. */
export const DEFAULT_BACKFILL_BATCH_SIZE = 300;

/**
 * Firestore's hard limit on the number of writes in a single batched write; the
 * backfill never stages more updates than this per batch (Req 4.2).
 */
export const MAX_BACKFILL_BATCH_SIZE = 500;

export interface BackfillConfig {
  /** Requested batch size; clamped to [1, {@link MAX_BACKFILL_BATCH_SIZE}]. */
  batchSize: number;
  /** Re-run even when a completion state is already recorded (bypasses no-op). */
  force?: boolean;
  /** Identifier of the run advancing progress (diagnostics only). */
  runnerId?: string;
}

export interface BackfillResult {
  /** Total device documents examined across every batch of this run. */
  processedCount: number;
  /** Device documents actually rewritten (skip-when-correct excluded). */
  updatedCount: number;
  /** Whether the sweep reached the end of the collection group. */
  completed: boolean;
}

/**
 * Clamp a requested batch size to `[1, MAX_BACKFILL_BATCH_SIZE]`, falling back
 * to {@link DEFAULT_BACKFILL_BATCH_SIZE} for a non-finite / non-positive input
 * (Req 4.2). Pure: no I/O.
 */
export function clampBatchSize(value: number | undefined): number {
  const n =
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : DEFAULT_BACKFILL_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BACKFILL_BATCH_SIZE, n));
}

/**
 * Whether a device's stored `tenantIndex` already equals its freshly-derived
 * index (the skip-when-correct decision — Req 4.5, 4.8). Both values are
 * canonical (de-duplicated, sorted), so equality reduces to an exact,
 * order-sensitive element comparison. A non-array stored value (missing /
 * malformed) is never equal, so it is rewritten. Pure: no I/O.
 */
export function tenantIndexMatches(stored: unknown, derived: readonly string[]): boolean {
  if (!Array.isArray(stored) || stored.length !== derived.length) {
    return false;
  }
  for (let i = 0; i < derived.length; i += 1) {
    if (stored[i] !== derived[i]) {
      return false;
    }
  }
  return true;
}

function toNonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Run the device tenant-index backfill to completion (or until a batch fails).
 *
 * Idempotent and resumable per {@link BackfillConfig}; see the module docstring
 * for the full contract. Returns the cumulative {@link BackfillResult} for this
 * run (including counts inherited from a resumed {@link Backfill_Progress}).
 */
export async function runDeviceTenantIndexBackfill(
  db: admin.firestore.Firestore,
  config: BackfillConfig
): Promise<BackfillResult> {
  const batchSize = clampBatchSize(config.batchSize);
  const force = config.force === true;
  const runnerId = (config.runnerId || '').trim() || 'unknown';

  const progressRef = db.doc(DEVICE_TENANT_INDEX_BACKFILL_PROGRESS_PATH);
  const progressSnap = await progressRef.get();
  const progressData = (progressSnap.exists ? progressSnap.data() ?? {} : {}) as Record<string, unknown>;
  const initialStatus = typeof progressData.status === 'string' ? progressData.status : null;

  // Idempotent no-op once completed, unless explicitly forced (Req 4.8).
  if (initialStatus === 'completed' && !force) {
    return {
      processedCount: toNonNegativeInt(progressData.processedCount),
      updatedCount: toNonNegativeInt(progressData.updatedCount),
      completed: true,
    };
  }

  // A forced re-run of an already-completed sweep restarts from the beginning
  // with fresh counters; a resume of an in-progress sweep continues from the
  // persisted cursor + counters (Req 4.4).
  const freshStart = initialStatus === 'completed';

  let processedCount = freshStart ? 0 : toNonNegativeInt(progressData.processedCount);
  let updatedCount = freshStart ? 0 : toNonNegativeInt(progressData.updatedCount);

  const persistedCursor =
    !freshStart && typeof progressData.resumeCursor === 'string' && progressData.resumeCursor.length > 0
      ? progressData.resumeCursor
      : null;

  // Resume: rebuild the pagination cursor from the persisted document path so a
  // restart continues exactly where the last successful batch left off. Even a
  // now-deleted doc's snapshot carries the `__name__` needed by `startAfter`.
  let cursorSnapshot: admin.firestore.DocumentSnapshot | null = null;
  if (persistedCursor) {
    cursorSnapshot = await db.doc(persistedCursor).get();
  }

  const startedAtValue =
    !freshStart && progressData.startedAt
      ? (progressData.startedAt as admin.firestore.FieldValue)
      : admin.firestore.FieldValue.serverTimestamp();

  // Initial marker write: record that this run is in progress. On a forced
  // fresh restart also reset the cursor + counters; on a resume this leaves the
  // persisted `resumeCursor`/counts untouched (merge) so nothing is lost.
  await progressRef.set(
    stripUndefinedDeep({
      status: 'in_progress',
      batchSize,
      runnerId,
      startedAt: startedAtValue,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(freshStart
        ? {
            resumeCursor: null,
            processedCount: 0,
            updatedCount: 0,
            completedAt: null,
          }
        : {}),
    }),
    { merge: true }
  );

  try {
    // Batch loop: page the collection group by document id for stable, resumable
    // pagination (see the design's backfill batch-loop diagram).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query: admin.firestore.Query = db
        .collectionGroup('devices')
        .orderBy(admin.firestore.FieldPath.documentId());
      if (cursorSnapshot) {
        query = query.startAfter(cursorSnapshot);
      }
      query = query.limit(batchSize);

      const snap = await query.get();
      const docs = snap.docs;
      const pageSize = docs.length;

      if (pageSize === 0) {
        // Prior page landed exactly on a batch boundary (or the collection group
        // is empty): the sweep is complete (Req 4.9).
        await progressRef.set(
          stripUndefinedDeep({
            status: 'completed',
            processedCount,
            updatedCount,
            resumeCursor: null,
            batchSize,
            runnerId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: admin.firestore.FieldValue.delete(),
          }),
          { merge: true }
        );
        return { processedCount, updatedCount, completed: true };
      }

      // Stage only the docs whose stored index differs from the derived one
      // (skip-when-correct — Req 4.5, 4.8).
      const batch = db.batch();
      let changed = 0;
      for (const doc of docs) {
        const data = (doc.data() ?? {}) as Record<string, unknown>;
        const derived = deriveTenantIndex(data as TenantScopedDevice);
        if (!tenantIndexMatches(data.tenantIndex, derived)) {
          batch.update(doc.ref, { tenantIndex: derived });
          changed += 1;
        }
      }

      // Commit the data batch FIRST (all-or-nothing); only then advance progress.
      if (changed > 0) {
        await batch.commit();
      }

      processedCount += pageSize;
      updatedCount += changed;
      const lastDoc = docs[pageSize - 1];
      cursorSnapshot = lastDoc;
      const cursorPath = lastDoc.ref.path;

      // End of collection group reached when the page was not full (Req 4.9).
      const isLastPage = pageSize < batchSize;

      await progressRef.set(
        stripUndefinedDeep({
          status: isLastPage ? 'completed' : 'in_progress',
          processedCount,
          updatedCount,
          resumeCursor: isLastPage ? null : cursorPath,
          batchSize,
          runnerId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          completedAt: isLastPage ? admin.firestore.FieldValue.serverTimestamp() : undefined,
          lastError: admin.firestore.FieldValue.delete(),
        }),
        { merge: true }
      );

      if (isLastPage) {
        return { processedCount, updatedCount, completed: true };
      }
    }
  } catch (error) {
    // Retain progress from previously committed batches (the persisted
    // `resumeCursor`/counts are untouched here) and record the failure so a
    // rerun resumes from the last successful cursor (Req 4.6).
    const message = error instanceof Error ? error.message : String(error);
    try {
      await progressRef.set(
        stripUndefinedDeep({
          status: 'in_progress',
          lastError: message,
          runnerId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
        { merge: true }
      );
    } catch {
      // Best-effort diagnostics; never mask the original failure.
    }
    throw error;
  }
}
