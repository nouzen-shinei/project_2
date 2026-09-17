/**
 * The Run_Lease — one Firestore document granting one execution the exclusive
 * right to sweep for a bounded period (storage-sweep-scale-hardening, Requirements
 * 5 and 6).
 *
 * ── Why this is its own module and not a block inside the Sweep_Core ─────────
 *
 * One reason, and it is the only one that matters: **the Sweep_Core must remain
 * structurally incapable of depending on the lease** (Req 5.16). Every guarantee
 * `storage-orphan-cleanup` states must hold whether or not a Run_Lease was
 * acquired, and the cheapest way to make that true rather than merely asserted is
 * for the core to have no import of this file at all. The core sees an optional
 * `renewRunLease` callback (task 9.3); the runner wires it (task 9.2); the lease
 * lives here.
 *
 * So the import direction is **lease → core** and must never be reversed. This
 * module imports `ORPHAN_SWEEP_PROGRESS_PATH` from the core so the Lease_Namespace
 * is *derived* from the Maintenance_Namespace rather than restated beside it — a
 * second copy of `'storageMaintenanceJobs/orphanSweep'` is exactly the drift this
 * spec has already had to repair once elsewhere. A core that imported this file
 * back would break Req 5.16 structurally.
 *
 * ── Where the lease document lives, and why that is the whole point ──────────
 *
 * `storageMaintenanceJobs/orphanSweep/leases/run`, INSIDE the Maintenance_Namespace
 * (Req 6.1, 6.10). **This spec introduces no write to `jobLeases/`** (Req 6.2), and
 * the reason is not tidiness:
 *
 *  1. `storage-orphan-cleanup`'s Property 6 — *report mode performs no mutation of
 *     any kind* — is asserted as a single namespace-prefix predicate: no Firestore
 *     write outside `storageMaintenanceJobs/`. A lease in `jobLeases/` would turn
 *     that predicate into an allow-list ("…except `jobLeases/`"), and an allow-list
 *     grows every time this job acquires a new bookkeeping need. Each growth is an
 *     edit to the one guarantee a maintainer reads before a destructive run, and a
 *     safety property with an exception is not one an operator can rely on
 *     (Req 6.3, 6.4).
 *  2. A lease is this job's own bookkeeping and holds no application data, which is
 *     what the Maintenance_Namespace is defined to contain (Req 6.5).
 *  3. The job's service account may write the Maintenance_Namespace and
 *     `tenantStorageUsage/` and nothing else. A `jobLeases/` lease would widen the
 *     Firestore write scope of the only identity in the project that can delete a
 *     tenant's objects — in order to add a *safety* mechanism (Req 6.6).
 *
 * `billingAutoCancelStalePending`'s `acquireRunLease` contributes its transactional
 * **shape** — a token, an `expiresAtMs`, a release that fires only for a matching
 * token — and deliberately **not** its collection.
 *
 * ── `firebase-admin` is a TYPE-ONLY import here, as it is in the core ────────
 *
 * So this module holds no `admin.firestore` namespace and no `FieldValue`, which is
 * why `updatedAt` below is a plain `Date` rather than a `serverTimestamp()`
 * sentinel: the set of writes this file is *able* to name is then exactly the set
 * its documentation claims. The Firestore SDK stores a `Date` as a `Timestamp`, so
 * the recorded shape is unchanged. `billingAutoCancelStalePending` uses the
 * sentinel; the core's discipline is the one followed here.
 *
 * ── Advisory, and what that word does and does not mean ─────────────────────
 *
 * "Advisory" describes what the lease **guarantees**: no correctness property of
 * `storage-orphan-cleanup` depends on it. The copy → verify → manifest → delete
 * ordering already makes every interleaving byte-safe, and `parseQuarantinePath`
 * reconstructs an original path from a Quarantine path alone, so recovery never
 * depended on one execution at a time. What the lease restores is **blast radius**
 * — the per-tenant Quarantine ceiling is enforced per process, so two overlapping
 * executions can move up to twice it — and an operator's ability to trust the
 * report's `sweepId` and resume cursor.
 *
 * "Advisory" does **not** mean acquisition may be skipped when it is inconvenient
 * (Req 5.22). Once the lease is wired into the runner there is no code path that
 * sweeps a tenant without a granted lease: a failure to acquire stops the sweep
 * rather than proceeding without it. See `acquireRunLease`'s note on the two
 * distinct outcomes. The qualifier "once wired into the runner" is load-bearing —
 * it is what keeps this paragraph from contradicting Req 5.16's structural
 * optionality in the core, where the callback stays optional precisely so the
 * parent's entire suite can run with no lease at all.
 *
 * ── This module reads no clock at load and has no import-time side effect ────
 *
 * Every `Date.now()` is inside a function, and `nowMs` is injectable throughout, so
 * expiry is testable without waiting.
 */

import crypto from 'node:crypto';
import type { firestore as FirestoreNS } from 'firebase-admin';

// Derived, never restated. See the import-direction note above.
import { ORPHAN_SWEEP_PROGRESS_PATH } from './storageOrphanSweep';

type Firestore = FirestoreNS.Firestore;

// ─── The path ────────────────────────────────────────────────────────────────

/**
 * `storageMaintenanceJobs/orphanSweep/leases` — three segments, so a valid
 * Firestore *collection* path, hanging off the run-level progress document the
 * Report_Documents already hang off. The Report_Document path
 * `storageMaintenanceJobs/orphanSweep/tenants/{tenantId}` is untouched (Req 6.10).
 */
export const ORPHAN_SWEEP_LEASE_COLLECTION = `${ORPHAN_SWEEP_PROGRESS_PATH}/leases`;

/**
 * A **FIXED** document id, not one per execution, and this is the mechanism rather
 * than a naming choice: mutual exclusion requires two executions to **contend on
 * one document**. A per-execution id — a uuid, the Sweep_Id, the runner id — would
 * give every execution its own uncontended document, so every acquisition would
 * succeed and the lease would prevent nothing while appearing to work.
 */
export const ORPHAN_SWEEP_RUN_LEASE_ID = 'run';

/**
 * `storageMaintenanceJobs/orphanSweep/leases/run` — four segments, an even count,
 * so a valid Firestore *document* path (Req 6.1, 6.10).
 */
export function runLeasePath(): string {
  return `${ORPHAN_SWEEP_LEASE_COLLECTION}/${ORPHAN_SWEEP_RUN_LEASE_ID}`;
}

/** Distinguishes this lease from any future one in the same collection. */
export const RUN_LEASE_JOB_NAME = 'storage_orphan_sweep_run';

// ─── The duration ────────────────────────────────────────────────────────────

/**
 * 45 minutes, and the number is chosen against the platform rather than picked:
 * it **exceeds `timeoutSeconds: 1800`** in both Cloud Run Job definitions by
 * design (Req 5.10), so the platform kills the task before the lease can expire
 * underneath a run that is still working. Both manifests set
 * `STORAGE_ORPHAN_SWEEP_LEASE_MS` to `2700000`, and task 8.4's
 * manifest-consistency test asserts `LEASE_MS / 1000 > timeoutSeconds` in each.
 *
 * A consequence worth stating because it is easy to get backwards: the expiry is
 * the **only** liveness mechanism — it is what makes an unreleased lease
 * self-healing after an out-of-memory kill or a platform timeout (Req 5.12) — and
 * renewal is therefore primarily a **fence**, not a liveness device. See
 * `RunLeaseHandle.renew`.
 */
export const DEFAULT_RUN_LEASE_MS = 45 * 60_000;

/** Following `acquireRunLease`'s clamp shape in `billingAutoCancelStalePending`. */
export const MIN_RUN_LEASE_MS = 5 * 60_000;
export const MAX_RUN_LEASE_MS = 6 * 60 * 60_000;

/**
 * Pure and **total over a value of any runtime type** (Req 5.11). A value that is
 * not a number, is non-finite, is not greater than zero, or truncates to zero
 * yields `DEFAULT_RUN_LEASE_MS`; any other value is truncated to whole
 * milliseconds and clamped into `[MIN_RUN_LEASE_MS, MAX_RUN_LEASE_MS]`.
 *
 * The truncate-to-zero rule is the same one `resolveQuarantineWriteThreshold`
 * states for the Quarantine_Write_Threshold, and it is here for the same reason: a
 * configured `0.5` is finite and positive, so a naive positive-number guard never
 * reaches its fallback, while `Math.trunc(0.5)` is `0` — and a resolved zero is a
 * lease that has already expired at the instant it is written, i.e. no lease at
 * all. Falling back to the documented default is the only safe resolution of a
 * value with no reading.
 *
 * **This lives here rather than in `lib/sweepScaleLimits.ts` deliberately**: it is
 * pure, but it is a property of the *lease*, not of the scale limits, and the pure
 * module's contract is the footprint estimate and the write cadence. Owning it
 * beside the document it bounds is what keeps the clamp and
 * `DEFAULT_RUN_LEASE_MS`'s comparison against `timeoutSeconds` in one place.
 */
export function clampRunLeaseMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_RUN_LEASE_MS;
  }
  const whole = Math.trunc(value);
  if (whole <= 0) return DEFAULT_RUN_LEASE_MS;
  return Math.max(MIN_RUN_LEASE_MS, Math.min(MAX_RUN_LEASE_MS, whole));
}

// ─── The document ────────────────────────────────────────────────────────────

/**
 * Exactly **ten** fields, every one of them this job's own bookkeeping, and **no
 * application data** (Req 6.5): no tenant record content, no object path, no
 * filename, no email address, and no token belonging to anything but the lease
 * itself.
 *
 * **The Lease_Token is a fence, not a credential.** Holding it grants no access to
 * anything — it only identifies which execution may renew or release this lease.
 * Leaking it would let a party who already had write access to the
 * Maintenance_Namespace release a lease, which is precisely the authority they
 * already have. That is why it is safe for the runner to log it (Req 5.17).
 */
export interface RunLeaseDoc {
  jobName: typeof RUN_LEASE_JOB_NAME;
  /** The Lease_Token. Per execution. Renewal and release must match it. */
  token: string;
  runnerId: string;
  /** The run's Sweep_Id, so a report and the lease that produced it can be tied together. */
  sweepId: string;
  mode: 'report' | 'sweep';
  acquiredAtMs: number;
  acquiredAtIso: string;
  /** The Lease_Expiry, epoch ms, as `acquireRunLease` in the billing job records it. */
  expiresAtMs: number;
  /** Renewals so far. One per tenant, so it is also "tenants started under this lease". */
  renewals: number;
  updatedAt: Date;
}

// ─── Results ─────────────────────────────────────────────────────────────────

export type RenewRunLeaseResult =
  | { ok: true; expiresAtMs: number }
  | { ok: false; reason: 'fenced' | 'missing' };

export interface RunLeaseHandle {
  readonly token: string;
  /**
   * The expiry this execution last recorded — updated on every successful renewal,
   * so a log line written at any point states the live window rather than the
   * acquisition-time one. Read by the runner's start-up line (Req 5.17).
   */
  expiresAtMs: number;
  /**
   * Extend the expiry, and — the part that actually matters — **check the recorded
   * token**.
   *
   * ── Renewal is a FENCE, not a liveness mechanism ──────────────────────────
   *
   * `DEFAULT_RUN_LEASE_MS` exceeds the job's `timeoutSeconds` by design, so the
   * platform kills the task before the lease can expire underneath it and renewal
   * therefore never *needs* to extend anything. Its value is that it reads the
   * token and notices if another execution has taken the lease. Saying so out loud
   * matters: a reader who assumes renewal is for liveness concludes that a
   * *mid-tenant* renewal is also needed, and a mid-tenant renewal would put a
   * Firestore transaction inside the object-listing page loop.
   *
   * Called by the core as the **first statement of each tenant iteration** (task
   * 9.3), never mid-tenant. `nowMs` is injectable so a test can drive expiry
   * without waiting; the zero-argument call shape is what the core's optional
   * `renewRunLease?: () => Promise<{ ok: boolean }>` accepts.
   *
   * Safe to call repeatedly: every call re-reads the token and either extends or
   * fences, and it never throws for a lease it does not hold. `renewals` counts
   * calls by design (see `RunLeaseDoc`), so it is a monotonically rising record of
   * tenants started under this lease rather than an idempotent field.
   */
  renew(nowMs?: number): Promise<RenewRunLeaseResult>;
  /**
   * Transactional, and a **no-op unless the recorded token is ours** (Req 5.7).
   * Idempotent: a second call finds no document and returns.
   */
  release(): Promise<void>;
}

export type AcquireRunLeaseResult =
  | { ok: true; handle: RunLeaseHandle }
  | {
      ok: false;
      reason: 'held';
      heldBy: { runnerId: string | null; expiresAtMs: number };
    };

// ─── Total coercions for what a document may actually contain ────────────────

/**
 * The recorded Lease_Expiry, or `null` when there is no usable one.
 *
 * **An absent, non-numeric or non-finite `expiresAtMs` yields `null`, which makes
 * the lease ACQUIRABLE.** Each of those is a lease nobody holds, and the
 * alternative is the failure mode that made the parent design reject a lease in
 * the first place: treating an unparseable expiry as *held* would let one bad write
 * — a hand edit, a partial write, a future field rename — block every sweep
 * **forever**, with no expiry to heal it and no signal beyond a run that quietly
 * declines every night. A stale-lease liveness failure is strictly worse than the
 * overlap the lease exists to prevent, because the overlap is bounded and
 * self-correcting and this is neither.
 */
function readRecordedExpiryMs(data: Record<string, unknown> | undefined): number | null {
  const value = data?.expiresAtMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRecordedToken(data: Record<string, unknown> | undefined): string | null {
  const value = data?.token;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecordedRunnerId(data: Record<string, unknown> | undefined): string | null {
  const value = data?.runnerId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecordedRenewals(data: Record<string, unknown> | undefined): number {
  const value = data?.renewals;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

// ─── Acquire ─────────────────────────────────────────────────────────────────

/**
 * Acquire the Run_Lease in **one** Firestore transaction on **exactly**
 * `runLeasePath()` and no other path (Req 5.2, 6.8), granting only where no
 * unexpired lease is recorded.
 *
 * Acquired in Report_Mode and Apply_Mode alike (Req 5.13) and regardless of
 * `force` (Req 5.14), because the Report_Document cursor and counters are written
 * in both modes and are last-writer-wins — an overlapping Report_Mode run can move
 * another execution's resume cursor backward without moving a single byte.
 *
 * ── DECLINED and FAILED are two distinct outcomes, distinguished at the TYPE
 *    level rather than by inspecting an error (Reqs 5.20, 5.21) ──────────────
 *
 * A **decline** is the return value `{ ok: false, reason: 'held' }`, and the runner
 * exits **zero**: another execution is doing the work, so nothing was skipped.
 * A **failure** is a **thrown** transaction — a Firestore outage, a permission
 * change on the Lease_Namespace — which propagates untouched, and the runner exits
 * **non-zero** with no tenant swept. Nothing in this function catches a transaction
 * error, so the only way to observe a failure is for the `await` to throw, and a
 * caller therefore *cannot* accidentally treat one as the other.
 *
 * Collapsing them is a real defect in **both** directions, which is why the
 * distinction is structural rather than documentary:
 *
 *  - treat a **failure as a decline** and a Firestore outage becomes a run of green
 *    no-ops that never sweeps anything again — the orphan estate grows and every
 *    task is a tidy exit 0;
 *  - treat a **decline as a failure** and routine scheduled contention pages
 *    someone every night, which trains an operator to ignore the one alert that
 *    means the sweep stopped.
 *
 * On a decline this function **writes nothing** — not a probe, not a counter, not a
 * "declined at" marker — so the holder's document is exactly as the holder left it.
 */
export async function acquireRunLease(args: {
  db: Firestore;
  runnerId: string;
  sweepId: string;
  mode: 'report' | 'sweep';
  leaseMs?: number;
  nowMs?: number;
}): Promise<AcquireRunLeaseResult> {
  const { db, runnerId, sweepId, mode } = args;
  const leaseRef = db.doc(runLeasePath());
  const durationMs = clampRunLeaseMs(args.leaseMs);
  const acquiredAtMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const expiresAtMs = acquiredAtMs + durationMs;
  const token = crypto.randomUUID();

  const outcome = await db.runTransaction(
    async (
      tx
    ): Promise<
      { granted: true } | { granted: false; heldBy: { runnerId: string | null; expiresAtMs: number } }
    > => {
      const snap = await tx.get(leaseRef);
      const data = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : undefined;
      const recordedExpiryMs = readRecordedExpiryMs(data);

      // Held only by an expiry that is BOTH readable and still in the future. A
      // `null` expiry (absent / non-numeric / non-finite) and a past expiry are
      // both leases nobody holds — see `readRecordedExpiryMs`.
      if (recordedExpiryMs !== null && recordedExpiryMs > acquiredAtMs) {
        return {
          granted: false,
          heldBy: { runnerId: readRecordedRunnerId(data), expiresAtMs: recordedExpiryMs },
        };
      }

      const doc: RunLeaseDoc = {
        jobName: RUN_LEASE_JOB_NAME,
        token,
        runnerId,
        sweepId,
        mode,
        acquiredAtMs,
        acquiredAtIso: new Date(acquiredAtMs).toISOString(),
        expiresAtMs,
        renewals: 0,
        updatedAt: new Date(),
      };

      // A plain `set` — deliberately NOT `{ merge: true }`, which is the one place
      // this departs from `billingAutoCancelStalePending`'s shape. An acquisition
      // is a fresh grant, not an update: no field of a previous holder's record may
      // survive it. That is what makes "exactly ten fields" a property of the
      // DOCUMENT rather than only of this payload, so Req 6.5's "no application
      // data in the Lease_Namespace" cannot be violated by an eleventh field some
      // earlier version wrote and this one merely failed to overwrite.
      //
      // `renew` below is the opposite case and uses `{ merge: true }` correctly.
      tx.set(leaseRef, doc);
      return { granted: true };
    }
  );

  if (!outcome.granted) {
    return { ok: false, reason: 'held', heldBy: outcome.heldBy };
  }

  return { ok: true, handle: createHandle({ db, leaseRef, token, durationMs, expiresAtMs }) };
}

// ─── The handle ──────────────────────────────────────────────────────────────

function createHandle(args: {
  db: Firestore;
  leaseRef: FirestoreNS.DocumentReference;
  token: string;
  durationMs: number;
  expiresAtMs: number;
}): RunLeaseHandle {
  const { db, leaseRef, token, durationMs } = args;

  const handle: RunLeaseHandle = {
    token,
    expiresAtMs: args.expiresAtMs,

    async renew(nowMs?: number): Promise<RenewRunLeaseResult> {
      const at = typeof nowMs === 'number' ? nowMs : Date.now();
      const nextExpiresAtMs = at + durationMs;

      const result = await db.runTransaction(async (tx): Promise<RenewRunLeaseResult> => {
        const snap = await tx.get(leaseRef);
        if (!snap.exists) {
          // The document was deleted under us. Terminal for the run, exactly as a
          // foreign token is: a lease we do not hold is one under which we must
          // start no further tenant (Req 5.9).
          return { ok: false, reason: 'missing' };
        }

        const data = (snap.data() ?? {}) as Record<string, unknown>;
        if (readRecordedToken(data) !== token) {
          // ── THE FENCING BRANCH WRITES NOTHING AND DELETES NOTHING ─────────
          //
          // A foreign token means the lease is lost **at the instant it is read**
          // (Req 5.18) — not at the end of the tenant in flight, and not "probably
          // lost, verify later". Because the core calls this as the first statement
          // of each tenant iteration, the instant of this reading and the instant
          // of the decision to start the next tenant are the same instant, so no
          // tenant is ever started under a lease that was already gone.
          //
          // And the document is left **exactly as its current holder recorded it**
          // (Req 5.19). Not renewed, not deleted, not touched. Releasing on the way
          // out would be strictly worse than doing nothing: it would strip the new
          // holder of the exclusivity it legitimately acquired and manufacture the
          // very overlap this mechanism exists to prevent — at the one moment two
          // executions are demonstrably live. `release()` below is a token-matched
          // no-op for the same reason, so the runner's `finally` is safe to call
          // after a fence.
          return { ok: false, reason: 'fenced' };
        }

        tx.set(
          leaseRef,
          {
            expiresAtMs: nextExpiresAtMs,
            renewals: readRecordedRenewals(data) + 1,
            updatedAt: new Date(),
          },
          // `{ merge: true }` is REQUIRED here, unlike in `acquireRunLease`: this
          // updates three fields of a document this execution already owns, and the
          // other seven must survive.
          { merge: true }
        );
        return { ok: true, expiresAtMs: nextExpiresAtMs };
      });

      if (result.ok) handle.expiresAtMs = result.expiresAtMs;
      return result;
    },

    async release(): Promise<void> {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        if (!snap.exists) return;
        const data = (snap.data() ?? {}) as Record<string, unknown>;
        if (readRecordedToken(data) !== token) {
          // A NO-OP, never a delete (Req 5.7). Releasing someone else's lease is
          // the one way this mechanism could itself CAUSE an overlap, so a
          // non-matching token must leave the document alone rather than tidy it
          // up. This is what makes the runner's unconditional `finally` release
          // safe even for an execution that has just been fenced.
          return;
        }
        tx.delete(leaseRef);
      });
    },
  };

  return handle;
}
