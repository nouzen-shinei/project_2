/**
 * Offline-device prune — core module (backend maintenance job).
 *
 * A re-runnable, idempotent-once-completed, batched, resumable sweep that
 * HARD-DELETES device documents (`user_devices/{email}/devices/{id}`) whose
 * last-seen time is older than a configurable threshold. It restores the
 * pruning of long-offline device docs that used to run client-side but was
 * removed because it required global cross-user scans/writes now denied by the
 * locked Firestore security rules; pruning is therefore relocated here as a
 * scheduled Admin-SDK backend job that runs with elevated privileges.
 *
 * ── Prune action: HARD DELETE (decided) ────────────────────────────────────
 * A stale device doc is permanently removed (`batch.delete(ref)`), not
 * soft-flagged. This is safe because:
 *   - `/devices/ping` writes with `set(..., { merge: true })`, so a device that
 *     returns after being pruned simply self-recreates a clean doc on its next
 *     ping — no orphaned/broken state.
 *   - Tenant-facing history lives in the append-only `deviceAuditLogs`
 *     collection, which is independent of the device doc and is NOT touched by
 *     this job. Deleting the device doc does not erase any audit trail.
 * A stale doc is deleted regardless of any `isDeleted` / tenant flags — this is
 * pure storage hygiene, so the ONLY predicate is staleness (see
 * {@link isStaleForPrune}); there is no special-casing.
 *
 * ── No per-device audit writes (decided) ───────────────────────────────────
 * This job deliberately does NOT write per-device `deviceAuditLogs` entries.
 * Pruning is storage hygiene, not a per-tenant admin action; emitting audit
 * rows would require resolving each device's tenant(s) and would spam every
 * tenant's history with maintenance noise. The durable run summary recorded on
 * the progress doc ({@link OFFLINE_DEVICE_PRUNE_PROGRESS_PATH}) is the record of
 * what the job did.
 *
 * ── Safety posture ─────────────────────────────────────────────────────────
 * Every knob defaults to the SAFE value. The core honors `dryRun` (scan + count
 * only, no deletes) and never prunes a device whose last-seen is unknown. The
 * runner ({@link ./runOfflineDevicePrune}) additionally gates the entire job
 * behind an opt-in enable flag that defaults OFF and a dry-run flag that
 * defaults ON.
 *
 * ── Resumable sweep contract (mirrors deviceTenantIndexBackfill) ────────────
 *   - Reads/writes durable progress at {@link OFFLINE_DEVICE_PRUNE_PROGRESS_PATH}.
 *     When `status === 'completed'` and `force` is not set, the run is an
 *     idempotent no-op.
 *   - Pages `collectionGroup('devices')` ordered by document id
 *     (`FieldPath.documentId()`), resuming from the persisted `resumeCursor`
 *     when present, so pagination is stable and resumable across restarts. Even
 *     a now-deleted doc's snapshot still carries the `__name__` that
 *     `startAfter` needs, and deleting earlier docs does not disturb an
 *     ascending document-id cursor.
 *   - In APPLY mode stages `batch.delete(ref)` for stale docs and COMMITS the
 *     batch FIRST, then persists progress. Persisting only AFTER the data commit
 *     means a mid-run failure leaves the last successful cursor intact
 *     (partial-failure retention).
 *   - Marks `status: 'completed'` + `completedAt` when a page returns fewer than
 *     `batchSize` docs (end of the collection group reached).
 *   - Clamps the batch size to <= 500 (the Firestore batched-write limit) and
 *     records `lastError` (retaining prior progress) on failure.
 *
 * The per-device prune decision it relies on ({@link isStaleForPrune}) is pure
 * and property-tested; this module performs the surrounding I/O.
 */

import * as admin from 'firebase-admin';

import { resolveDeviceLastSeenMs } from '../lib/deviceLastSeen';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';

/** Firestore progress doc recording the offline-device prune run summary. */
export const OFFLINE_DEVICE_PRUNE_PROGRESS_PATH = 'deviceMaintenanceJobs/offlineDevicePrune';

/** Milliseconds in a day. */
export const DAY_MS = 86_400_000;

/** Default prune batch size when none / an invalid one is configured. */
export const DEFAULT_PRUNE_BATCH_SIZE = 300;

/**
 * Firestore's hard limit on the number of writes in a single batched write; the
 * prune never stages more deletes than this per batch.
 */
export const MAX_PRUNE_BATCH_SIZE = 500;

/** Default staleness threshold (days) when none / an invalid one is configured. */
export const DEFAULT_PRUNE_MAX_AGE_DAYS = 14;

export interface PruneConfig {
  /** Requested batch size; clamped to [1, {@link MAX_PRUNE_BATCH_SIZE}]. */
  batchSize: number;
  /** Staleness threshold in days; a device last seen before `now - days` prunes. */
  maxAgeDays: number;
  /** When true (the SAFE default posture), scan + count only — perform NO deletes. */
  dryRun: boolean;
  /** Re-run even when a completion state is already recorded (bypasses no-op). */
  force?: boolean;
  /** Identifier of the run advancing progress (diagnostics only). */
  runnerId?: string;
  /** Reference "now" epoch-ms; defaults to `Date.now()`. Injectable for tests. */
  nowMs?: number;
}

export interface PruneResult {
  /** Total device documents examined across every batch of this run. */
  processedCount: number;
  /** Stale device documents identified this run (= would-delete in dry-run). */
  staleCount: number;
  /** Device documents actually hard-deleted this run (0 in dry-run). */
  deletedCount: number;
  /** Whether the sweep reached the end of the collection group. */
  completed: boolean;
  /** Whether this run was a dry-run (no deletes). */
  dryRun: boolean;
}

/**
 * Clamp a requested batch size to `[1, MAX_PRUNE_BATCH_SIZE]`, falling back to
 * {@link DEFAULT_PRUNE_BATCH_SIZE} for a non-finite / non-positive input. Pure.
 */
export function clampBatchSize(value: number | undefined): number {
  const n =
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : DEFAULT_PRUNE_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_PRUNE_BATCH_SIZE, n));
}

/**
 * Parse an env-provided max-age (in days), falling back to
 * {@link DEFAULT_PRUNE_MAX_AGE_DAYS} for a missing / non-finite / non-positive
 * value. The result is truncated to a whole number of days. Pure.
 */
export function resolveMaxAgeDays(value: string | undefined | null): number {
  if (value === undefined || value === null || value.trim().length === 0) {
    return DEFAULT_PRUNE_MAX_AGE_DAYS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PRUNE_MAX_AGE_DAYS;
  }
  return Math.trunc(parsed);
}

/**
 * Compute the prune cutoff: a device last seen strictly BEFORE this epoch-ms is
 * stale. `cutoffMs = nowMs - maxAgeDays * DAY_MS`. Pure.
 */
export function computeCutoffMs(nowMs: number, maxAgeDays: number): number {
  return nowMs - maxAgeDays * DAY_MS;
}

/**
 * Whether a device is stale enough to prune: `true` ONLY when the device's
 * last-seen epoch-ms is RESOLVABLE and strictly less than `cutoffMs`.
 *
 * Uses the shared {@link resolveDeviceLastSeenMs} — the exact same conversion
 * the Device Console read path uses — so "stale" here always agrees with the
 * console's notion of last-seen (preferring a finite numeric `lastSeenMs`, else
 * an ISO `lastSeen` string, else a Firestore `Timestamp` via
 * `toMillis()`/`toDate()`).
 *
 * CRITICAL SAFETY: when last-seen is NOT resolvable (missing / non-finite /
 * unparseable), this returns `false`. A device with an unknown last-seen is
 * NEVER pruned — this protects brand-new or malformed docs from being mistaken
 * for very old ones. The comparison is strict (`<`), so a device seen exactly at
 * the cutoff is NOT stale. Pure: no I/O.
 */
export function isStaleForPrune(device: Record<string, unknown>, cutoffMs: number): boolean {
  const lastSeenMs = resolveDeviceLastSeenMs(device);
  if (lastSeenMs === null || !Number.isFinite(lastSeenMs)) {
    return false;
  }
  return lastSeenMs < cutoffMs;
}

function toNonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Run the offline-device prune to completion (or until a batch fails).
 *
 * Idempotent-once-completed and resumable per {@link PruneConfig}; see the module
 * docstring for the full contract. Returns the cumulative {@link PruneResult} for
 * this run (including counts inherited from a resumed progress doc).
 *
 * NOTE: the enable-gate lives in the runner, NOT here — the core can be invoked
 * directly by tests. The `dryRun` posture, however, IS honored here.
 */
export async function runOfflineDevicePrune(
  db: admin.firestore.Firestore,
  config: PruneConfig
): Promise<PruneResult> {
  const batchSize = clampBatchSize(config.batchSize);
  const maxAgeDays =
    Number.isFinite(config.maxAgeDays) && config.maxAgeDays > 0
      ? Math.trunc(config.maxAgeDays)
      : DEFAULT_PRUNE_MAX_AGE_DAYS;
  const dryRun = config.dryRun !== false; // SAFE default: anything but explicit false is a dry-run
  const force = config.force === true;
  const runnerId = (config.runnerId || '').trim() || 'unknown';
  const nowMs = typeof config.nowMs === 'number' && Number.isFinite(config.nowMs) ? config.nowMs : Date.now();
  const cutoffMs = computeCutoffMs(nowMs, maxAgeDays);

  const progressRef = db.doc(OFFLINE_DEVICE_PRUNE_PROGRESS_PATH);
  const progressSnap = await progressRef.get();
  const progressData = (progressSnap.exists ? progressSnap.data() ?? {} : {}) as Record<string, unknown>;
  const initialStatus = typeof progressData.status === 'string' ? progressData.status : null;

  // Idempotent no-op once completed, unless explicitly forced.
  if (initialStatus === 'completed' && !force) {
    return {
      processedCount: toNonNegativeInt(progressData.processedCount),
      staleCount: toNonNegativeInt(progressData.staleCount),
      deletedCount: toNonNegativeInt(progressData.deletedCount),
      completed: true,
      dryRun: progressData.dryRun === true,
    };
  }

  // A forced re-run of an already-completed sweep restarts from the beginning
  // with fresh counters; a resume of an in-progress sweep continues from the
  // persisted cursor + counters.
  const freshStart = initialStatus === 'completed';

  let processedCount = freshStart ? 0 : toNonNegativeInt(progressData.processedCount);
  let staleCount = freshStart ? 0 : toNonNegativeInt(progressData.staleCount);
  let deletedCount = freshStart ? 0 : toNonNegativeInt(progressData.deletedCount);

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

  // Initial marker write: record that this run is in progress along with the run
  // parameters. On a forced fresh restart also reset the cursor + counters; on a
  // resume this leaves the persisted cursor/counts untouched (merge).
  await progressRef.set(
    stripUndefinedDeep({
      status: 'in_progress',
      dryRun,
      maxAgeDays,
      cutoffMs,
      batchSize,
      runnerId,
      startedAt: startedAtValue,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(freshStart
        ? {
            resumeCursor: null,
            processedCount: 0,
            staleCount: 0,
            deletedCount: 0,
            completedAt: null,
          }
        : {}),
    }),
    { merge: true }
  );

  try {
    // Batch loop: page the collection group by document id for stable, resumable
    // pagination (identical to the tenant-index backfill).
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
        // is empty): the sweep is complete.
        await progressRef.set(
          stripUndefinedDeep({
            status: 'completed',
            dryRun,
            processedCount,
            staleCount,
            deletedCount,
            resumeCursor: null,
            maxAgeDays,
            cutoffMs,
            batchSize,
            runnerId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: admin.firestore.FieldValue.delete(),
          }),
          { merge: true }
        );
        return { processedCount, staleCount, deletedCount, completed: true, dryRun };
      }

      // Identify stale docs; in APPLY mode stage a delete for each.
      const batch = db.batch();
      let staleThisPage = 0;
      for (const doc of docs) {
        const data = (doc.data() ?? {}) as Record<string, unknown>;
        if (isStaleForPrune(data, cutoffMs)) {
          staleThisPage += 1;
          if (!dryRun) {
            batch.delete(doc.ref);
          }
        }
      }

      // Commit the data batch FIRST (all-or-nothing); only then advance progress.
      // In dry-run nothing is staged, so nothing is committed.
      if (!dryRun && staleThisPage > 0) {
        await batch.commit();
      }

      processedCount += pageSize;
      staleCount += staleThisPage;
      if (!dryRun) {
        deletedCount += staleThisPage;
      }
      const lastDoc = docs[pageSize - 1];
      cursorSnapshot = lastDoc;
      const cursorPath = lastDoc.ref.path;

      // End of collection group reached when the page was not full.
      const isLastPage = pageSize < batchSize;

      await progressRef.set(
        stripUndefinedDeep({
          status: isLastPage ? 'completed' : 'in_progress',
          dryRun,
          processedCount,
          staleCount,
          deletedCount,
          resumeCursor: isLastPage ? null : cursorPath,
          maxAgeDays,
          cutoffMs,
          batchSize,
          runnerId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          completedAt: isLastPage ? admin.firestore.FieldValue.serverTimestamp() : undefined,
          lastError: admin.firestore.FieldValue.delete(),
        }),
        { merge: true }
      );

      if (isLastPage) {
        return { processedCount, staleCount, deletedCount, completed: true, dryRun };
      }
    }
  } catch (error) {
    // Retain progress from previously committed batches (the persisted
    // `resumeCursor`/counts are untouched here) and record the failure so a
    // rerun resumes from the last successful cursor.
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
