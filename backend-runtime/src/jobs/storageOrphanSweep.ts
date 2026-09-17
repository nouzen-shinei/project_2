/**
 * Storage orphan sweep — Phase 1 (the Reference_Collector) and Phase 2 (the
 * listing, the per-object disposition, the quota settlement and the report).
 *
 * Mirrors `jobs/offlineDevicePrune.ts`: the core is directly invocable by tests
 * and every enable gate lives in the runner (task 10).
 *
 * ── What each phase is allowed to write ──────────────────────────────────────
 *
 * `collectTenantReferenceSet` (Phase 1) writes NOTHING: not to Storage, not to
 * Firestore, not to the Realtime Database, in report mode and in sweep mode
 * alike (Req 6.13). Every call it makes is a `.get()`.
 *
 * `sweepTenant` (Phase 2) writes the job's own Report_Document under
 * `storageMaintenanceJobs/` in BOTH modes — that namespace holds this job's
 * bookkeeping and no application data, which is why Property 6 excludes it from
 * "mutation" by name — and, in APPLY mode only, the tenant's
 * `tenantStorageUsage` record. Nothing else, in either mode: no bucket mutator,
 * no Realtime Database write, no other Firestore collection.
 *
 * `firebase-admin` remains imported as a TYPE ONLY, which is why every timestamp
 * written below is a plain `Date` rather than a `FieldValue.serverTimestamp()`
 * sentinel and `lastError` is cleared with `null` rather than
 * `FieldValue.delete()`. The module therefore holds no `FieldValue`, no
 * `admin.firestore` namespace and no bucket handle — the bucket arrives as an
 * argument — so the set of writes it is *able* to name is exactly the set the two
 * paragraphs above describe. The Firestore SDK stores a `Date` as a `Timestamp`,
 * so the document shape still matches the design.
 *
 * ── Why a retain set, and why a failure aborts ───────────────────────────────
 *
 * A false positive destroys user data; a false negative wastes bytes. So the
 * sweep computes what is PROVEN referenced and reports only the complement, and
 * an enumeration that could not read everything must stop rather than conclude
 * that the objects it could not see are unreferenced. Hence every source is
 * wrapped in its own try/catch that appends to `failedSources` rather than
 * throwing, and the caller is handed the abort decision on the return value
 * (`abortReason`) rather than being asked to remember the three conditions
 * (Req 9.1, 9.2, 9.11).
 *
 * ── The finding that shapes the enumeration ──────────────────────────────────
 *
 * **Chat attachments live in the Realtime Database, not Firestore**, at
 * `tenantChat/{tenantId}/conversationMessages/{conversationKey}/{messageId}` —
 * confirmed by `chatMessageWriter.ts` (`tenantChatRootRef` + `sendChatMessage`,
 * whose message record carries `fileUrl` / `thumbnailUrl` / `attachments[]`, and
 * `deleteStorageObjectsForMessage`, which reads exactly those fields back) and by
 * `database.rules.json`. `chat-files/{tenantId}/` is the largest prefix in the
 * bucket, so a collector that enumerated only Firestore would find no reference
 * to any chat attachment and would report every one of them as an orphan. The
 * RTDB is therefore a first-class source here, with its own pagination and its
 * own correctness property (Property 9).
 */

import crypto from 'node:crypto';
// Node's built-in heap statistics, for the mid-collection guard's default reading.
// A built-in, so this adds no dependency and keeps the module free of `express` and
// of any runtime `firebase-admin` import.
import v8 from 'node:v8';
import type { database as DatabaseNS, firestore as FirestoreNS } from 'firebase-admin';

import {
  DAY_MS,
  DEFAULT_GRACE_DAYS,
  DEFAULT_QUARANTINE_RETENTION_DAYS,
  computeGraceCutoffMs,
  decideObjectDisposition,
  type ObjectDisposition,
  type ObjectFacts,
} from '../lib/orphanDecision';
// In-process counters. `metrics.ts` imports nothing at all, so this stays clear of
// `express` and `firebase-admin`; `inc`/`incBy` are map writes and can reach no
// store. See the "Observability" block below for why a counter alone is not enough
// from a job.
import { inc, incBy, metricNames } from '../metrics';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';
// The report-write cadence, decided in ONE pure place (spec task 1.2) so Reqs
// 7.1–7.5 are that function's postcondition rather than this call site's
// behaviour. No clock, no I/O: the live elapsed milliseconds are handed in.
import {
  DEFAULT_REPORT_WRITE_PAGE_INTERVAL,
  DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS,
  HEAP_GUARD_SAMPLE_INTERVAL,
  estimateRetainSetFootprintBytes,
  exceedsHeapGuard,
  resolveQuarantineWriteThreshold,
  shouldWriteTenantReport,
} from '../lib/sweepScaleLimits';
import {
  QUARANTINE_PREFIX,
  STORAGE_TENANT_CATEGORIES,
  TenantScopeViolation,
  assertTenantScoped,
  buildQuarantinePath,
  classifyTenantScopedPath,
  deriveProfilePicturePath,
  isDerivedProfilePictureFilename,
  parseQuarantinePath,
  resolveBucketObjectPath,
} from '../lib/storageObjectRef';
// The ONE authoritative quota recompute, extracted from `app.ts` in task 3.2 so
// the sweep settles quota with the same function `POST /storage/reconcile` uses.
import { estimateTenantStorageBytes } from '../lib/tenantStorageUsage';
// The transcoder's OWN derivation, exported in task 3.1 precisely so no copy of
// it can drift from the writer. A copy that drifted deletes transcoded videos.
import { buildTranscodeStoragePath } from '../videoTranscoder';

type Firestore = FirestoreNS.Firestore;
type RealtimeDatabase = DatabaseNS.Database;
type DataSnapshot = DatabaseNS.DataSnapshot;

// ─── Constants ───────────────────────────────────────────────────────────────

/** Run-level progress/report namespace, following `deviceMaintenanceJobs/…`. */
export const ORPHAN_SWEEP_PROGRESS_PATH = 'storageMaintenanceJobs/orphanSweep';

/** Per-tenant report + resume state. */
export function tenantReportPath(tenantId: string): string {
  return `${ORPHAN_SWEEP_PROGRESS_PATH}/tenants/${tenantId}`;
}

/**
 * Hard ceiling on the retain set. Exceeding it ABORTS the tenant — the sweep
 * never proceeds with a truncated retain set, because a truncated retain set is
 * indistinguishable from a set of orphans (Req 9.7).
 *
 * ── Why 500,000 and not the 2,000,000 this shipped with (Req 8.1) ────────────
 *
 * At `RETAIN_SET_BYTES_PER_PATH` (232 B, see `lib/sweepScaleLimits.ts`) a ceiling
 * of 2,000,000 estimates at ≈ **464 MB** of live retain set, which does not fit a
 * `512Mi` container at all and does not fit `1Gi` with a declared 896 MB
 * old-space limit either: `0.7 × 896 MB ≈ 627 MB`. So the documented
 * `reference_cap_exceeded` abort could not fire — the container was killed first,
 * exit 137, with no Report_Document explaining itself. THAT is the defect this
 * number fixes, and it is why the runner now refuses to start when the estimate
 * for the configured ceiling exceeds the Heap_Guard_Fraction of the observed
 * Heap_Limit (Req 8.6): a ceiling that cannot fit is a misconfiguration, not a
 * runtime surprise.
 *
 * 500,000 estimates at ≈ **116 MB**, comfortably inside the 627 MB guard the
 * configured `1Gi` container produces, which leaves the abort reachable and the
 * estimate's headroom real.
 *
 * The cost, stated plainly: a tenant legitimately holding more than 500,000
 * references now aborts where it previously *attempted* the sweep. That is the
 * safe direction — an abort quarantines nothing and writes a report saying why —
 * and it is one environment variable away from being raised deliberately, by an
 * operator who has read the logged estimate and the logged heap limit.
 *
 * Both Cloud Run Job definitions carry this same number in
 * `STORAGE_ORPHAN_SWEEP_MAX_REFERENCES` (Req 9.11), and
 * `storageOrphanSweepManifests.test.ts` asserts the two cannot drift.
 */
export const DEFAULT_MAX_REFERENCES = 500_000;

/**
 * Conversations per level-1 RTDB page, and messages per level-2 page.
 *
 * The conversation page is deliberately SMALL. The Admin SDK has no shallow
 * key-only read (`shallow=true` exists only on the REST API), so a level-1 page
 * transfers the subtree of each conversation it names; this collector reads only
 * the KEYS from that page and never calls `val()` on it, so nothing is retained,
 * but the transfer is real and a small page is what bounds it. The authoritative
 * enumeration is the level-2 read, which is paginated per conversation.
 */
export const DEFAULT_CONVERSATION_PAGE_SIZE = 20;
export const DEFAULT_MESSAGE_PAGE_SIZE = 200;

/**
 * Documents per page for every Firestore reference query and for the
 * active-tenant query (Req 3.12).
 *
 * 1000 matches `collectPaymentsReceived`'s `PAGE_SIZE` in
 * `jobs/tenantUsageRollup.ts`, whose keyset loop this module's
 * `forEachQueryDocPaged` copies rather than reinvents — one page size across the
 * two jobs means one number to reason about when a collection turns out to be
 * larger than anyone expected.
 *
 * Overridable through `STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE`, which is parsed
 * by `parsePositiveIntEnv` and therefore falls back to THIS number rather than to
 * zero for a non-finite, non-positive or unparseable value (Req 3.13).
 *
 * The page size is a memory knob and nothing else: `retainPaths`,
 * `referenceFingerprint` and `countsBySource` are invariant under it for a fixed
 * fixture, which is what lets it be changed on a deploy without discarding every
 * in-flight resume cursor (the fingerprint is the stale-resume detector).
 */
export const DEFAULT_FIRESTORE_PAGE_SIZE = 1_000;

/**
 * Cap on the cross-tenant sample recorded on the report. The unbounded total is
 * kept separately in `crossTenantReferenceCount`, because that count is what the
 * alert policy watches (task 10.3/10.4) and a truncated sample must not silence
 * it.
 */
export const MAX_RECORDED_CROSS_TENANT_REFERENCES = 100;

/** Longest value accepted as an email for profile-picture derivation (RFC 5321). */
const MAX_EMAIL_LENGTH = 320;

/** Depth and node budget for the generic `branding` leaf walk. */
const MAX_LEAF_WALK_DEPTH = 6;
const MAX_LEAF_WALK_NODES = 500;

/**
 * Extensions treated as "a chat video" when deriving `{base}_h264.mp4`.
 *
 * The transcoder itself decides by content type, not by extension, and this
 * collector has only the object path — so this list is the path-side
 * approximation. Being wrong in the inclusive direction is safe (one extra
 * derived string) but not free: a derived path that names no object is counted as
 * a Dangling_Reference by task 6.2, so deriving for every chat object regardless
 * of extension would bury the report in noise.
 */
const VIDEO_PATH_EXTENSIONS: ReadonlySet<string> = new Set([
  '3gp',
  'avi',
  'flv',
  'hevc',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'mts',
  'ogv',
  'ts',
  'webm',
  'wmv',
]);

// ═════════════════════════════════════════════════════════════════════════════
// Observability — an in-process counter AND a structured log line, for each of
// which only one is actually readable from a job
// ═════════════════════════════════════════════════════════════════════════════
//
// **The distinction a future reader will trip over, stated where they will hit
// it.** `src/metrics.ts` holds in-process counters, exposed over the Express app's
// `/metrics` endpoint. This sweep is a Cloud Run **job**: nothing scrapes it, and
// its heap is gone the moment the task exits. So `inc(metricNames.storageOrphanSweep…)`
// from this module is correct, cheap and **invisible to Cloud Monitoring**. A
// dashboard or alert built on the scraped counter would read a flat zero forever
// — and a zero on a condition that is *supposed* to sit at zero is
// indistinguishable from everything being fine, which is the specific failure
// worth engineering against here (Req 16.12, 16.13).
//
// What actually reaches Cloud Monitoring from a job is its **logs**. So all
// eleven counters are ALSO emitted as a single-line JSON object, which Cloud Run
// parses into `jsonPayload`, and from which a **log-based metric** is extracted:
// `logging.googleapis.com/user/storage_orphan_sweep_aborted_total` and
// `…_cross_tenant_references_total` are exactly what
// `infra/monitoring/storage-orphan-sweep-alert-policy.json` alerts on. The filter
// each one uses is `jsonPayload.metric="<name>"`, the value comes from
// `jsonPayload.value`, and the labels come from the remaining fields — so the
// emitted shape below is load-bearing, not cosmetic. `infra/monitoring/README.md`
// carries the `gcloud logging metrics create` commands that must match it.
//
// **So: from a job, exactly the eleven metrics emitted as log lines are
// observable, and none of the in-process counters are.** Nothing here is
// half-instrumented — every counter this module moves also gets a line — but the
// two alerted signals are the ones a log-based metric MUST exist for, because a
// policy whose metric never receives a point is indistinguishable from a
// condition that is holding at zero.
//
// Deliberately NOT done: pushing to the Cloud Monitoring API from the job, or
// running a sidecar. Either is a new credential, a new failure mode and a new
// dependency in a job whose whole point is to be inert until switched on. Counters
// plus log lines is the entire mechanism.
//
// Three constraints on the payload, all of them requirements:
//
//  1. **Labels are `tenant_id`, `mode`, `reason`, `outcome` and `abort_reason`,
//     and nothing else** (Req 16.7). No object path, no filename, no email, no
//     download token (Req 16.8, 16.9, 16.10). `metric`, `value`, `message` and
//     `severity` are the envelope Cloud Logging needs, not data about a tenant's
//     files.
//  2. **One line per metric per tenant, carrying THIS process's delta**, not the
//     tenant's cumulative counters. The counters are inherited across a resume
//     (`countersFromProgress`), so emitting them raw would re-report the earlier
//     attempt's objects and make a resumed run look like a busier one. The delta
//     is what the in-process counter also received, so the two agree by
//     construction — which is why an accumulating metric is counted per object by
//     `countSweepMetric` and logged once per tenant by `logSweepMetric`, and a
//     one-shot signal does both at once through `emitSweepMetric`. Doing both for
//     one delta would double it.
//  3. **A zero is not emitted.** `incBy` ignores a non-positive delta and the
//     emitter skips the line, so an absent series means "did not happen" rather
//     than "was not instrumented" — with the single exception of
//     `runs_total`, one line per tenant per invocation labelled by `outcome`
//     (`completed` / `aborted` / `in_progress`), emitted precisely so that "the
//     job ran" is visible on a run that found nothing to do.
//
//     Which is why a run over an EMPTY tenant list emits one `runs_total` line
//     with `outcome: 'completed'` and NO `tenant_id` — see the emit in
//     `runStorageOrphanSweep`. Without it the exception above defeated itself: the
//     one run shape with genuinely nothing to do was the one shape that said
//     nothing. `tenant_id` is simply absent rather than empty, which the closed
//     label type already permits and `compactLabels` already handles.

/**
 * The complete permitted label set (Req 16.7). Excess keys cannot be expressed.
 *
 * ── EXPORTED for the runner, and deliberately still CLOSED (spec task 9.2) ────
 *
 * The Run_Lease's `acquired` and `contended` outcomes are emitted from
 * `runStorageOrphanSweep.ts`, because acquisition happens in the runner — before
 * the core is entered at all — and the lease module's own documented property is
 * that it performs one transaction on one document and owns no observability
 * concern. So the runner needs this type and `emitSweepMetric` below.
 *
 * The alternative was a third hand-rolled `console.log(JSON.stringify(...))` in the
 * runner, and it is REJECTED: Req 10.3 requires the single-line JSON shape the
 * deployed `infra/monitoring/` filters match to be *inherited rather than
 * reimplemented*, and a second copy of that shape is exactly how it drifts away
 * from a filter no deploy can update transactionally.
 *
 * Exporting widens who may *emit*; it widens nothing about *what may be said*. The
 * five keys are still the whole permitted set (Req 10.1) — do not add a sixth for a
 * caller's convenience. The lease line carries `mode` and `outcome` only and no
 * `tenant_id`, because a lease is run-level and names no tenant.
 */
export interface SweepMetricLabels {
  tenant_id?: string;
  mode?: string;
  reason?: string;
  outcome?: string;
  abort_reason?: string;
}

function compactLabels(labels: SweepMetricLabels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Move the in-process counter only.
 *
 * Called at the same points the report counters move, which is per object for the
 * scan and retention counters. That is a map write and a small key string — the
 * listing round-trip that produced the object dominates it by orders of magnitude.
 */
function countSweepMetric(name: string, labels: SweepMetricLabels, value = 1): void {
  if (value === 1) {
    inc(name, compactLabels(labels));
    return;
  }
  incBy(name, value, compactLabels(labels));
}

/**
 * Emit the structured line a log-based metric matches, and move NO counter.
 *
 * This is the only path by which a number computed inside a Cloud Run job becomes
 * visible in Cloud Monitoring. Used once per metric per tenant for the
 * accumulating counters, carrying THIS process's delta, because their in-process
 * counters were already moved object by object by `countSweepMetric` — calling
 * both for the same delta would double it.
 *
 * `severity` is `WARNING` for the two signals that are alerted on and `INFO` for
 * the rest, so an operator scanning the job's logs by eye sees the same two
 * signals the policy does.
 */
function logSweepMetric(
  name: string,
  labels: SweepMetricLabels,
  value: number,
  severity: 'INFO' | 'WARNING' = 'INFO'
): void {
  if (!Number.isFinite(value) || value <= 0) return;
  // A SINGLE line of JSON: Cloud Run parses it into `jsonPayload`, and a multi-line
  // payload would be ingested as several unparsed text entries instead. The keys
  // are load-bearing: `infra/monitoring/README.md`'s `gcloud logging metrics
  // create` filters match on `jsonPayload.metric`, take the value from
  // `jsonPayload.value` and extract the labels from the remaining fields.
  console.log(
    JSON.stringify({
      severity,
      message: `[orphan_sweep] metric ${name}`,
      metric: name,
      value,
      ...compactLabels(labels),
    })
  );
}

/**
 * Move the in-process counter **and** emit the line, for a ONE-SHOT event whose
 * counter is not also moved per object: a run outcome, an abort, the per-tenant
 * cross-tenant total, the per-tenant dangling total.
 *
 * The rule that keeps the two surfaces agreeing: for any one delta, call EITHER
 * `emitSweepMetric` (one-shot) OR `countSweepMetric` + `logSweepMetric`
 * (accumulated per object, logged once per tenant). Never both.
 *
 * ── EXPORTED for the runner's two lease outcomes (spec task 9.2) ─────────────
 *
 * `countSweepMetric` and `logSweepMetric` stay module-private: the runner has no
 * per-object counter to move and no per-tenant delta to flush, so the one-shot pair
 * is the only shape it needs, and keeping the other two private keeps the
 * "EITHER/OR, never both" rule above a rule about calls inside this file. See
 * `SweepMetricLabels` for why the runner emits through this rather than through a
 * copy of the JSON shape.
 */
export function emitSweepMetric(
  name: string,
  labels: SweepMetricLabels,
  value: number,
  severity: 'INFO' | 'WARNING' = 'INFO'
): void {
  if (!Number.isFinite(value) || value <= 0) return;
  countSweepMetric(name, labels, value);
  logSweepMetric(name, labels, value, severity);
}

// ─── The reference sources ───────────────────────────────────────────────────

export const REFERENCE_SOURCE_IDS = [
  'rtdb_chat_messages',
  'video_transcodes',
  'shared_files',
  'fees',
  'notices',
  'students',
  'tenant_branding',
  'profile_pictures_derived',
] as const;

export type ReferenceSourceId = (typeof REFERENCE_SOURCE_IDS)[number];

export interface ReferenceSource {
  /** Stable id used in the report and in `failedSources`. */
  id: ReferenceSourceId;
  /** Which Managed_Categories this source is the reference authority for. */
  covers: readonly string[];
}

/**
 * The eight sources and the prefixes they answer for. Three sources cover
 * `chat-files` independently, which is the point: any one of them retains, so
 * losing two still retains the object.
 */
export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  { id: 'rtdb_chat_messages', covers: ['chat-files'] },
  { id: 'video_transcodes', covers: ['chat-files'] },
  { id: 'shared_files', covers: ['chat-files'] },
  { id: 'fees', covers: ['receipts'] },
  { id: 'notices', covers: ['notices'] },
  { id: 'students', covers: ['student_profiles'] },
  { id: 'tenant_branding', covers: ['tenant-branding'] },
  { id: 'profile_pictures_derived', covers: ['profile-pictures'] },
];

/**
 * The three conditions under which the caller (task 6.1's `sweepTenant`) MUST
 * abort the tenant's run having mutated nothing. Task 6 widens this union with
 * the two conditions that can only arise during Phase 2
 * (`tenant_scope_violation`, `quarantine_cap_reached`).
 */
export type ReferenceAbortReason =
  | 'reference_source_failed'
  | 'malformed_reference'
  | 'reference_cap_exceeded';

export interface TenantReferenceSet {
  tenantId: string;
  retainPaths: Set<string>;
  /** sha256 over the SORTED paths, so equal sets yield equal fingerprints. */
  referenceFingerprint: string;
  /**
   * Per-source counts, for the report and for spotting a source that silently
   * returned nothing (Req 6.16).
   *
   * Counted per ACCEPTED reference — every value that resolved to an in-scope
   * path — not per insertion into `retainPaths`. The sources overlap by design
   * (one chat object is legitimately proven by a message, a share document and a
   * transcode document), so counting insertions only would show `0` for a source
   * whose paths another source happened to reach first, which is exactly the
   * "silently returned nothing" signal this field exists to give. The sum is
   * therefore ≥ `retainPaths.size`, as the design's postcondition states.
   */
  countsBySource: Record<ReferenceSourceId, number>;
  /**
   * Firestore pages READ per source, including the terminating empty page
   * (Req 10.7). Zero for the two sources that issue no paged query: the Realtime
   * Database walk, and `tenant_branding`'s single `tenants/{tenantId}` document
   * read (Req 4.5).
   *
   * `profile_pictures_derived` accumulates the pages of BOTH collections it reads
   * — `tenantMemberships` and `tenantProfiles` — because the unit is the
   * Reference_Source, which is what the metric's `reason` label carries.
   *
   * This is the cheapest place to notice a walk that stopped after one page: a
   * source with a non-zero `countsBySource` and a `pagesBySource` of 1 over a
   * collection larger than the page size is the shape of a cursor that never
   * advanced.
   */
  pagesBySource: Record<ReferenceSourceId, number>;
  /**
   * The subset of `retainPaths` that was admitted by DERIVATION rather than by
   * reading a reference field: the profile-picture paths derived from member
   * emails (source 8) and the `{base}_h264.mp4` outputs derived from chat video
   * paths.
   *
   * Both families are *expected* to name objects that frequently do not exist —
   * a member who never uploaded an avatar, a video that was never transcoded —
   * so Phase 2 excludes them from `danglingReferenceCount` (Req 15.1). Counting
   * them would make that number roughly "the number of members", burying the one
   * signal it exists to give: that some deletion path is removing objects
   * without clearing the record that names them.
   *
   * A path that is BOTH derived and field-referenced (an avatar that also has a
   * live `photoURL`) is recorded here, so the dangling count under-counts
   * slightly rather than over-counting. That is the right direction for a number
   * an operator watches for movement.
   */
  derivedPaths: Set<string>;
  /**
   * Chat-file paths first proven by a `videoTranscodes` document — i.e. paths the
   * RTDB walk, which runs FIRST, did not reference at all.
   *
   * This is the observable shape of Req 8.10: a chat video message soft-deleted
   * while its `videoTranscodes` document survives still references its objects,
   * so they are retained, and this is the "record the observation" half. The same
   * shape also arises when the transcoder's RTDB write-back never landed, so the
   * field is named for what it measures rather than for one of its causes.
   *
   * Derived `_h264.mp4` paths are excluded: they are new by construction and
   * would drown the signal.
   */
  transcodeOnlyReferences: string[];
  /** Unbounded total behind the bounded sample above. */
  transcodeOnlyReferenceCount: number;
  /**
   * Bounded sample of references that parsed to a path OUTSIDE this tenant's
   * scope. Recorded and EXCLUDED from `retainPaths`; the run continues
   * (Req 4.6, 4.7, 4.8).
   */
  crossTenantReferences: string[];
  /** Unbounded total behind the bounded sample above. */
  crossTenantReferenceCount: number;
  /**
   * References that failed to parse. Non-zero ABORTS this tenant: an unparseable
   * reference means some object is referenced and we do not know which.
   */
  malformedReferences: number;
  /**
   * Non-empty ⇒ at least one source could not be enumerated ⇒ the sweep for this
   * tenant is ABORTED. Report mode still writes its partial report, clearly
   * marked (Req 9.10).
   */
  failedSources: { id: ReferenceSourceId; message: string }[];
  /**
   * The abort decision, resolved here so the caller cannot forget to check it
   * (Req 9.11). `null` ⇒ the retain set is complete and may be used.
   *
   * Precedence matches task 6.1: a failed source, then a malformed reference,
   * then a breached ceiling.
   */
  abortReason: ReferenceAbortReason | null;
  /**
   * WHICH ceiling bound first, when one did (Req 8.9). `null` ⇒ neither.
   *
   *  - `'configured'` — `retainPaths.size` exceeded `maxReferences`, the check the
   *    shipped code already made after every insertion (Req 8.16);
   *  - `'memory_guard'` — the mid-collection heap sample tripped **both**
   *    conditions of `exceedsHeapGuard` (Req 8.8).
   *
   * ── Diagnostic, NOT behavioural, and that is why `SweepAbortReason` is untouched
   *
   * Both breaches produce `abortReason: 'reference_cap_exceeded'` and both
   * quarantine nothing, because the gate in `sweepTenant` precedes any listing so
   * zero objects move (Req 8.12). A sixth `SweepAbortReason` value would have
   * invalidated every existing metric label, every `infra/monitoring/` filter and
   * every report reader for a distinction that changes no behaviour (Req 8.10) — so
   * the distinction lives here and on the Report_Document root instead.
   */
  capBreach: 'configured' | 'memory_guard' | null;
  /**
   * `estimateRetainSetFootprintBytes(retainPaths.size)` — what the set this
   * collector actually built is estimated to cost.
   *
   * Distinct from the Report_Document's `params.footprintEstimateBytes`, which is
   * the estimate for the configured **ceiling** and is a run parameter. This one is
   * an observation about one tenant, and the pair is what tells an operator whether
   * a tenant is anywhere near the ceiling it was judged against.
   */
  footprintEstimateBytes: number;
  /**
   * The Heap_Limit the last heap sample reported, or `null` when no sample was
   * taken or the reading was unusable.
   *
   * `null` is the ordinary case rather than a failure: the heap is sampled once per
   * `HEAP_GUARD_SAMPLE_INTERVAL` admitted references (Req 8.7), so a tenant with
   * fewer than 10,000 references is never sampled at all and has no reading to
   * report. It is the limit the guard COMPARED against, which is why an unreadable
   * one is recorded as `null` rather than as a substituted default.
   */
  heapLimitBytes: number | null;
}

export interface CollectTenantReferenceSetArgs {
  db: Firestore;
  rtdb: RealtimeDatabase;
  tenantId: string;
  bucketName: string;
  maxReferences: number;
  /**
   * Documents per Firestore page, defaulting to `DEFAULT_FIRESTORE_PAGE_SIZE`
   * (Req 3.12, 3.13).
   *
   * OPTIONAL, so this exported signature does not change shape: every existing
   * caller keeps compiling and gets the documented default. A test drives a
   * multi-page walk cheaply by passing a small value, and `retainPaths`,
   * `referenceFingerprint` and `countsBySource` are identical whatever it passes.
   */
  firestorePageSize?: number;
  /** Overridable only so tests can exercise multi-page RTDB walks cheaply. */
  conversationPageSize?: number;
  messagePageSize?: number;
  /**
   * The heap READING the mid-collection guard samples, defaulting to
   * `readProcessHeapUsage` — a `v8.getHeapStatistics()` call and nothing else.
   *
   * ── Why the reading is injected and the COMPARISON is not ───────────────────
   *
   * Only the reading is a seam. The comparison stays the pure `exceedsHeapGuard`,
   * so a test can put the crossing at a chosen admitted-reference count instead of
   * trying to make a real heap grow to 128 MiB — and it still exercises the same
   * two-condition predicate production runs. A seam over the comparison would let a
   * test assert a guard that is present without asserting the guard that is
   * correct.
   *
   * Production installs nothing, so the default IS the behaviour, following the
   * `quarantineObject` / `invalidateLiveCount` precedent.
   */
  readHeapUsage?: () => { usedBytes: number; limitBytes: number };
}

/**
 * The default heap reading: `v8.getHeapStatistics()`, coerced.
 *
 * Total by construction. `getHeapStatistics` is a native call that does not throw
 * in any documented case, but a non-numeric field would otherwise flow into
 * `exceedsHeapGuard` — which is total too and returns `false` for it, i.e.
 * "continue" — so the coercion here is belt to that brace and keeps the collector's
 * "never throws for an enumeration concern" posture intact for a *measurement*
 * concern as well.
 *
 * `NaN` is the honest value for an unreadable field, and it is the direction that
 * does NOT abort a tenant: an unreadable limit mid-collection is not evidence of a
 * memory problem, and that input was already settled at start-up by the runner's
 * Req 8.6 refusal.
 */
export function readProcessHeapUsage(): { usedBytes: number; limitBytes: number } {
  try {
    const stats = v8.getHeapStatistics();
    const usedBytes = typeof stats?.used_heap_size === 'number' ? stats.used_heap_size : Number.NaN;
    const limitBytes = typeof stats?.heap_size_limit === 'number' ? stats.heap_size_limit : Number.NaN;
    return { usedBytes, limitBytes };
  } catch {
    return { usedBytes: Number.NaN, limitBytes: Number.NaN };
  }
}

// ─── Internal helpers (pure) ─────────────────────────────────────────────────

/**
 * The bound on any error text this module stores, in BYTES.
 *
 * ── Why a bound exists at all ────────────────────────────────────────────────
 *
 * `describeThrownValue` returns a thrown string verbatim, and its output lands in
 * two unbounded fields of the tenant report document: `failedSources[].message`
 * and `lastError`. Firestore rejects any document over 1,048,576 bytes. The
 * realistic worst case for everything ELSE on that document is about 411 KB, so
 * there is headroom — an unbounded field is what closes it.
 *
 * What makes this worth bounding rather than noting is the failure mode. The FINAL
 * `writeTenantReport` runs outside any try/catch, after the quarantine work and
 * after the `tenantStorageUsage` write. A document Firestore refuses therefore
 * means the report is never finalised and `logTenantMetricDeltas()` never runs — a
 * run that moved objects would leave no record of having done so, which is the
 * exact opposite of what this report exists for.
 *
 * BYTES, not UTF-16 code units, because the limit being modelled is a byte limit —
 * the same reason `MAX_OBJECT_PATH_LENGTH_BYTES` in `lib/storageObjectRef.ts`
 * counts bytes. 2048 astral-plane characters are 8192 bytes.
 *
 * 2 KiB is chosen to be far more than any real error message and small enough that
 * the whole of `failedSources` cannot approach the document limit: it holds at most
 * one entry per `REFERENCE_SOURCE_IDS`, so the worst case is 8 × 2 KiB = 16 KiB
 * against 1,048,576 B.
 */
export const MAX_ERROR_MESSAGE_BYTES = 2048;

/**
 * The marker appended when a message is cut, so a truncated message is VISIBLY
 * truncated rather than merely short — otherwise a reader cannot tell a cut
 * message from a terse thrower.
 */
const ERROR_MESSAGE_ELISION = '… [truncated]';

/**
 * Cut `text` to `MAX_ERROR_MESSAGE_BYTES` UTF-8 bytes, marker included, never
 * splitting a code point.
 *
 * Iterating with `for…of` walks code POINTS, so a surrogate pair is never halved
 * into a lone surrogate; and the `break` fires within the byte budget, so the walk
 * never touches more of a pathologically long input than the budget allows,
 * whatever its total length.
 */
function boundErrorMessage(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_ERROR_MESSAGE_BYTES) return text;

  const budget = MAX_ERROR_MESSAGE_BYTES - Buffer.byteLength(ERROR_MESSAGE_ELISION, 'utf8');
  let bytes = 0;
  let units = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > budget) break;
    bytes += size;
    units += character.length;
  }
  return text.slice(0, units) + ERROR_MESSAGE_ELISION;
}

/**
 * Coerce ANY thrown value into a non-empty, LENGTH-BOUNDED message, without ever
 * throwing itself: an `Error`, a permission error, a timeout, a string, a number,
 * `null`, `undefined`, a symbol, or an object whose `message` getter or `toString`
 * throws (Req 9.2).
 *
 * The bound is applied on the way out rather than at each call site, so every
 * consumer — `failedSources[].message`, `lastError`, the quarantine mover's
 * per-stage message — inherits it and none can forget to.
 */
export function describeThrownValue(value: unknown): string {
  return boundErrorMessage(describeThrownValueUnbounded(value));
}

function describeThrownValueUnbounded(value: unknown): string {
  const FALLBACK = 'unknown error';

  const fromMessage = (candidate: unknown): string | null => {
    try {
      const message = (candidate as { message?: unknown })?.message;
      return typeof message === 'string' && message.trim() ? message : null;
    } catch {
      return null;
    }
  };

  if (value instanceof Error) {
    const message = fromMessage(value);
    if (message) return message;
    try {
      const name = value.name;
      if (typeof name === 'string' && name.trim()) return name;
    } catch {
      // fall through
    }
    return 'Error';
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.trim() ? value : FALLBACK;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') {
    try {
      return value.toString();
    } catch {
      return FALLBACK;
    }
  }

  const message = fromMessage(value);
  if (message) return message;
  try {
    const text = String(value);
    return text.trim() ? text : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/**
 * Read one field of an untrusted Firestore/RTDB record as `unknown`, tolerating
 * a non-object record and a property whose getter throws (Req 17.12). Nothing
 * read through here is ever interpolated into a bucket path — every value goes
 * to the Path_Mapper, which decides what it names.
 */
function readField(record: unknown, key: string): unknown {
  if (record === null || typeof record !== 'object') return undefined;
  try {
    return (record as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Every string-valued leaf of a nested record, bounded in depth and node count
 * and cycle-safe. Used for the tenant `branding` object so a sixth branding
 * field added later cannot become an enumeration gap (Req 6.11).
 */
function collectStringLeaves(value: unknown): string[] {
  const leaves: string[] = [];
  const seen = new Set<unknown>();
  let budget = MAX_LEAF_WALK_NODES;

  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_LEAF_WALK_DEPTH) return;
    budget -= 1;
    if (typeof node === 'string') {
      leaves.push(node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    let entries: unknown[];
    try {
      entries = Array.isArray(node) ? node.slice() : Object.values(node as Record<string, unknown>);
    } catch {
      return;
    }
    for (const entry of entries) walk(entry, depth + 1);
  };

  walk(value, 0);
  return leaves;
}

/**
 * A chat message's `attachments`, as an iterable of entries.
 *
 * Both an array and an object with numeric keys are accepted: the RTDB returns a
 * node with contiguous numeric keys as an array and one with a gap as an object,
 * and the transcoder writes into `attachments/{i}/transcodedUrl` — so a gap is
 * reachable. `chatMessageWriter` reads only the array form; reading both here is
 * the retention-safe direction.
 */
function iterateAttachments(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    try {
      return Object.values(value as Record<string, unknown>);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Whether an object path is a chat video of this tenant, i.e. a candidate for the
 * derived `{base}_h264.mp4` retention. A path that is already a transcode output
 * is excluded, so nothing derives `…_h264_h264.mp4`.
 */
export function isChatVideoObjectPath(objectPath: string, tenantId: string): boolean {
  if (typeof objectPath !== 'string') return false;
  if (!objectPath.startsWith(`chat-files/${tenantId}/`)) return false;
  if (objectPath.endsWith('_h264.mp4')) return false;
  const filename = objectPath.slice(objectPath.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return false;
  return VIDEO_PATH_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

/** Ordered child keys of a snapshot, WITHOUT reading any child's value. */
function snapshotChildKeys(snapshot: DataSnapshot): string[] {
  const keys: string[] = [];
  snapshot.forEach((child) => {
    const key = child.key;
    if (typeof key === 'string' && key.length > 0) keys.push(key);
    // `false` never cancels the enumeration.
    return false;
  });
  return keys;
}

/** Ordered `{ key, value }` children of a snapshot. */
function snapshotChildren(snapshot: DataSnapshot): { key: string; value: unknown }[] {
  const children: { key: string; value: unknown }[] = [];
  snapshot.forEach((child) => {
    const key = child.key;
    if (typeof key === 'string' && key.length > 0) {
      let value: unknown;
      try {
        value = child.val();
      } catch {
        value = undefined;
      }
      children.push({ key, value });
    }
    return false;
  });
  return children;
}

function normalisePositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

// ─── The Reference_Page_Helper ────────────────────────────────────────────────

/**
 * One keyset-paginated walk over `collection` where `field == value`, in ascending
 * document-name order, handing each matching document's data and id to `handler`
 * exactly once.
 *
 * `onPage` fires once per page successfully READ, including the terminating empty
 * page. It is a callback rather than a return value on purpose: a walk that throws
 * on its fifth page has still read four, and the caller's `pagesBySource` should
 * say so — a return value would report nothing for exactly the source whose page
 * count an operator most wants to see.
 *
 * This is the design's `forEachTenantDocPaged` — the single Reference_Page_Helper
 * every Firestore Reference_Source is enumerated through (Req 3.1, 3.8) —
 * generalised in exactly ONE dimension: the equality filter's FIELD is a
 * parameter. That is what makes `resolveSweepTenantIds`'s `all_active` branch
 * (`status == 'active'`) literally this loop rather than a second copy of it
 * (Req 4.1). Nothing else differs between the two call sites, so there is one
 * paging implementation in this module and not two that can drift.
 *
 * The loop's shape is copied from `collectPaymentsReceived` in
 * `jobs/tenantUsageRollup.ts` rather than reinvented.
 *
 * ── `orderBy('__name__')` AND NO OTHER FIELD (Req 3.4), for two reasons ───────
 *
 * The first is a correctness trap: Firestore EXCLUDES from a result set any
 * document that lacks the ordering field. Ordering by anything optional therefore
 * drops documents silently — and a dropped document is a reference never
 * collected, which makes the object it names an Orphan candidate. `__name__`
 * cannot be absent.
 *
 * The second is operational: an equality filter plus `orderBy('__name__')` in the
 * same direction is served by the automatically maintained single-field index on
 * the filtered field, so NO composite index has to be deployed. Any other ordering
 * field needs one; a missing index is a query failure; a query failure is a
 * `failedSources` entry; a `failedSources` entry aborts the tenant.
 *
 * ── The cursor is a `QueryDocumentSnapshot`, never a field value (Req 3.3) ────
 *
 * `startAfter(someTenantId)` over documents that all share one `tenantId` either
 * returns nothing or returns everything, and the failure that matters is the
 * *skip*: a skipped document is a reference not collected. So the cursor is
 * always the last snapshot of the page just handled.
 *
 * ── TWO INDEPENDENT STOP CONDITIONS, not one ─────────────────────────────────
 *
 * A short page ends the walk (Req 3.5), and an EMPTY page ends the walk on its
 * own — checked BEFORE the handler loop, for every page size (Req 3.17). They look
 * like one rule wearing two hats and they are not. At `pageSize: 1` every
 * non-empty page is a FULL page, so the short-page test never fires; over a
 * collection whose document count is an exact multiple of the page size the empty
 * page is the ONLY thing that terminates the loop. Collapsing the two is an
 * infinite loop, not a wrong answer.
 *
 * Checking empty first also means the cursor is only ever taken from a page that
 * had a last document, so `page.docs[page.size - 1]` is never `undefined`.
 *
 * ── `shouldStop`, before each request and after each handled document ─────────
 *
 * The configured reference ceiling and the heap guard both set a flag the caller
 * already consults in every other loop; `forEachTenantDoc` had nothing to check
 * because it did not loop. Evaluating `shouldStop` before requesting each page is
 * what makes a cap-exceeded or heap-guarded tenant STOP READING rather than page
 * through all seven collections to grow a set it has already refused.
 *
 * ── Memory (Req 3.6, 3.7) ────────────────────────────────────────────────────
 *
 * At most one page's `docs` array is reachable at a time, plus the single cursor
 * snapshot. Reqs 3.3 and 3.6 are in mild tension and this is the resolution: the
 * cursor is ONE document, not a handle onto its page, so "one page plus one
 * document" is the true bound. The page reference is dropped before the next
 * round-trip is issued and nothing is accumulated across pages — the handler
 * extracts the strings it wants and nothing else escapes.
 *
 * ── Failure (Req 3.9) ────────────────────────────────────────────────────────
 *
 * This function does not catch. The caller's `try` is around the WHOLE walk, not
 * around the first request, so a failure on the LAST page still propagates to
 * `runSource` and lands in `failedSources`. A `try` around only the first request
 * passes every single-page fixture and swallows exactly the case pagination
 * introduces.
 *
 * Performs no write.
 */
async function forEachQueryDocPaged(args: {
  db: Firestore;
  collection: string;
  /** The equality filter's field: `tenantId` for a Reference_Source, `status` for `all_active`. */
  field: string;
  value: string;
  /** Already normalised to a positive integer by the caller. */
  pageSize: number;
  /** Total and side-effect free. Evaluated before each request and after each document. */
  shouldStop: () => boolean;
  handler: (data: unknown, docId: string) => void;
  /** Called once per page successfully read, the terminating empty page included. */
  onPage?: () => void;
}): Promise<void> {
  const { db, collection, field, value, pageSize, shouldStop, handler, onPage } = args;

  // A `QueryDocumentSnapshot`, never a field value (Req 3.3).
  let cursor: FirestoreNS.QueryDocumentSnapshot | null = null;
  let page: FirestoreNS.QuerySnapshot | null = null;

  for (;;) {
    if (shouldStop()) return;

    let query: FirestoreNS.Query = db
      .collection(collection)
      .where(field, '==', value)
      .orderBy('__name__')
      .limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);

    // Release the previous page's snapshots BEFORE the next round-trip, so the
    // walk holds one page plus one cursor document and never two pages (Req 3.7).
    page = null;
    page = await query.get();
    if (onPage) onPage();

    // STOP CONDITION 1 — an empty page, checked BEFORE the handler loop and
    // independently of the short-page test below (Req 3.17). At `pageSize: 1`, and
    // over any collection whose count is an exact multiple of the page size, this
    // is the only terminator. It also guarantees the cursor assignment below never
    // indexes an empty array.
    if (page.empty) return;

    for (const doc of page.docs) {
      let data: unknown;
      try {
        data = doc.data();
      } catch {
        data = undefined;
      }
      handler(data, doc.id);
      if (shouldStop()) return;
    }

    // The LAST SNAPSHOT of this page — the only thing that survives the next
    // iteration's reassignment of `page`.
    cursor = page.docs[page.size - 1];

    // STOP CONDITION 2 — a short page (Req 3.5).
    if (page.size < pageSize) return;
  }
}

// ─── Phase 1 ─────────────────────────────────────────────────────────────────

/**
 * Read every reference source for one tenant and return the retain set.
 *
 * Preconditions: `tenantId` is trimmed and non-empty, and `db`/`rtdb` handles are
 * present. A missing RTDB handle is a configuration error, not an enumeration
 * failure — it would make every chat attachment look unreferenced, which is the
 * single most dangerous misconfiguration in the design — so it throws here and is
 * refused even earlier by the runner (Req 5.7). Everything else fails toward the
 * return value.
 *
 * Postconditions:
 *  - performs NO write of any kind;
 *  - never throws for an enumeration failure — each source's failure is appended
 *    to `failedSources` with a coerced message;
 *  - every member of `retainPaths` satisfies `classifyTenantScopedPath(path, tenantId)`;
 *  - `referenceFingerprint` is a function of the retain set alone;
 *  - `abortReason` is non-null exactly when the caller must abort;
 *  - every Firestore Reference_Source is read through the keyset-paginated
 *    `forEachQueryDocPaged`, and `retainPaths`, `referenceFingerprint` and
 *    `countsBySource` are INVARIANT under `firestorePageSize` for a fixed fixture
 *    — the page size bounds memory and decides no verdict about any object.
 */
export async function collectTenantReferenceSet(
  args: CollectTenantReferenceSetArgs
): Promise<TenantReferenceSet> {
  const tenantId = typeof args.tenantId === 'string' ? args.tenantId.trim() : '';
  if (!tenantId) {
    throw new TypeError('collectTenantReferenceSet: tenantId is required');
  }
  if (!args.db) {
    throw new TypeError('collectTenantReferenceSet: a Firestore handle is required');
  }
  if (!args.rtdb) {
    // Chat attachments live ONLY in the Realtime Database. Proceeding without a
    // handle would silently produce a retain set with no chat paths at all.
    throw new TypeError(
      'collectTenantReferenceSet: a Realtime Database handle is required; set FIREBASE_DATABASE_URL'
    );
  }

  const db = args.db;
  const rtdb = args.rtdb;
  const bucketName = typeof args.bucketName === 'string' ? args.bucketName : '';
  const maxReferences = normalisePositiveInt(args.maxReferences, DEFAULT_MAX_REFERENCES);
  const firestorePageSize = normalisePositiveInt(
    args.firestorePageSize,
    DEFAULT_FIRESTORE_PAGE_SIZE
  );
  const conversationPageSize = normalisePositiveInt(
    args.conversationPageSize,
    DEFAULT_CONVERSATION_PAGE_SIZE
  );
  const messagePageSize = normalisePositiveInt(args.messagePageSize, DEFAULT_MESSAGE_PAGE_SIZE);
  // The READING is the seam; the comparison below is the pure `exceedsHeapGuard`.
  const readHeapUsage = args.readHeapUsage ?? readProcessHeapUsage;

  const retainPaths = new Set<string>();
  const derivedPaths = new Set<string>();
  const failedSources: { id: ReferenceSourceId; message: string }[] = [];
  const crossTenantSample = new Set<string>();
  const transcodeOnlySample = new Set<string>();
  const emails = new Set<string>();
  let transcodeOnlyReferenceCount = 0;
  let crossTenantReferenceCount = 0;
  let malformedReferences = 0;
  let capExceeded = false;
  /** WHICH ceiling bound first (Req 8.9). Set exactly where `capExceeded` is. */
  let capBreach: 'configured' | 'memory_guard' | null = null;
  /**
   * Admitted references since the last heap sample. Reset at each sample, so the
   * heap is read once per `HEAP_GUARD_SAMPLE_INTERVAL` admissions (Req 8.7) — cheap
   * relative to the Firestore round-trip that produced them, and fine-grained
   * enough that the overshoot between two samples is at most
   * `10,000 × 232 B ≈ 2.3 MB` against a guard measured in hundreds of MB.
   */
  let admittedSinceHeapSample = 0;
  /** The last sampled Heap_Limit, or `null` when unsampled or unreadable. */
  let heapLimitBytes: number | null = null;

  const countsBySource = REFERENCE_SOURCE_IDS.reduce((acc, id) => {
    acc[id] = 0;
    return acc;
  }, {} as Record<ReferenceSourceId, number>);

  // Initialised for EVERY source, for the same reason `countsBySource` is: a key
  // that is present and zero says "this source read no page", which is a signal;
  // an absent key says only that nobody instrumented it.
  const pagesBySource = REFERENCE_SOURCE_IDS.reduce((acc, id) => {
    acc[id] = 0;
    return acc;
  }, {} as Record<ReferenceSourceId, number>);

  /**
   * The ONE admission path. Every source routes through it, so no source can
   * bypass a check:
   *
   *   1. resolve the value against OUR bucket;
   *   2. `malformed` ⇒ count it (⇒ the tenant will abort); `empty`,
   *      `not_a_storage_url` and `foreign_bucket` ⇒ ignore silently, because a
   *      cleared field, a raw path in a url field, a Giphy sticker and a Google
   *      avatar are all ordinary rather than failures (Req 3.17, 3.18);
   *   3. apply the Scope_Guard — guard 1 of the design's three — and on failure
   *      record the path, EXCLUDE it, and continue the run;
   *   4. insert, count, and check the ceiling immediately.
   *
   * The ceiling is evaluated INSIDE the loop, right after each insertion, so it
   * bounds memory rather than being discovered once the set has already grown
   * (Req 9.8). Once breached, admission stops: `retainPaths` never exceeds
   * `maxReferences + 1`, which keeps the caller's `size > maxReferences` gate
   * true while refusing to grow further.
   *
   * ── The heap guard sits at the SAME point, for the same reason (Req 8.7, 8.8) ──
   *
   * The configured ceiling catches a retain set that outgrew a number an operator
   * chose. The heap guard catches one that outgrew the number the estimate PREDICTED
   * — a path longer than the 120 bytes charged for it, a V8 representation that
   * costs more than the 48-byte slot assumed, anything the estimator got wrong. Both
   * belong at the single admission point, because that is the only place the set
   * grows, and both set `capExceeded`, which `shouldStop` reads: a breached tenant
   * stops READING rather than merely stopping admitting.
   */
  const offer = (
    value: unknown,
    sourceId: ReferenceSourceId,
    allowBarePath: boolean,
    options?: {
      /**
       * TRUE for a path this collector DERIVED (a profile picture from an email,
       * a `_h264.mp4` from a video path) rather than read out of a field. Affects
       * only what is recorded — `derivedPaths` and the transcode observation —
       * never whether the path is retained.
       */
      derived?: boolean;
    }
  ): void => {
    if (capExceeded) return;

    const resolved = resolveBucketObjectPath(value, bucketName, { allowBarePath });
    if (!resolved.ok) {
      if (resolved.reason === 'malformed') malformedReferences += 1;
      return;
    }

    if (!classifyTenantScopedPath(resolved.objectPath, tenantId).ok) {
      crossTenantReferenceCount += 1;
      if (crossTenantSample.size < MAX_RECORDED_CROSS_TENANT_REFERENCES) {
        crossTenantSample.add(resolved.objectPath);
      }
      return;
    }

    countsBySource[sourceId] += 1;
    const isNew = !retainPaths.has(resolved.objectPath);
    if (options?.derived === true) {
      derivedPaths.add(resolved.objectPath);
    } else if (
      isNew &&
      sourceId === 'video_transcodes' &&
      resolved.objectPath.startsWith(`chat-files/${tenantId}/`)
    ) {
      // Source 1 (the RTDB walk) has already run, so a chat path first seen here
      // is one no chat message references. See `transcodeOnlyReferences`.
      transcodeOnlyReferenceCount += 1;
      if (transcodeOnlySample.size < MAX_RECORDED_CROSS_TENANT_REFERENCES) {
        transcodeOnlySample.add(resolved.objectPath);
      }
    }
    if (isNew) {
      retainPaths.add(resolved.objectPath);
      admittedSinceHeapSample += 1;

      if (retainPaths.size > maxReferences) {
        // Unchanged from the shipped behaviour (Req 8.16); only the `capBreach`
        // label is new.
        capExceeded = true;
        capBreach = 'configured';
      } else if (admittedSinceHeapSample >= HEAP_GUARD_SAMPLE_INTERVAL) {
        admittedSinceHeapSample = 0;
        const heap = readHeapUsage();
        // Recorded as GIVEN, so the report states what the guard compared. `null`
        // for an unusable reading rather than a substituted default: a limit we
        // could not read is a fact worth reporting, and a default standing in for
        // it would hide the one signal that tells an operator `NODE_OPTIONS` never
        // reached the process.
        heapLimitBytes =
          typeof heap.limitBytes === 'number' && Number.isFinite(heap.limitBytes)
            ? heap.limitBytes
            : null;
        // BOTH conditions, and neither is inline (Req 8.8, 8.17, 8.18):
        //   usedBytes > HEAP_GUARD_FLOOR_BYTES (128 MiB)
        //   AND usedBytes > 0.7 × limitBytes
        // A reading at or below the floor keeps collecting whatever fraction of the
        // reported limit it represents, so a misreported one-byte limit cannot abort
        // a tenant holding a handful of references; and a non-finite or non-positive
        // limit is likewise NOT a breach — an unreadable limit is not evidence of a
        // memory problem, and that input was already settled at start-up by the
        // runner's Req 8.6 refusal.
        if (exceedsHeapGuard(heap.usedBytes, heap.limitBytes)) {
          capExceeded = true;
          capBreach = 'memory_guard';
        }
      }
    }
  };

  /** Run one source, converting any thrown value into a `failedSources` entry. */
  const runSource = async (id: ReferenceSourceId, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (error) {
      failedSources.push({ id, message: describeThrownValue(error) });
    }
  };

  /**
   * An email seen on a record, for the profile-picture derivation. Lower-cased
   * only to deduplicate — the derivation itself always calls the writer's own
   * resolver, which applies the writer's normalisation.
   */
  const collectEmail = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) return;
    emails.add(trimmed.toLowerCase());
  };

  /**
   * `where('tenantId','==',t)` over one collection, KEYSET-PAGINATED, read-only.
   *
   * The whole body is `forEachQueryDocPaged`; this closure only supplies the two
   * things the walk cannot know — which Reference_Source the pages belong to, and
   * that "stop" means "the retain-set ceiling has been breached". So all seven
   * Firestore Reference_Sources are paginated by paginating one place (Req 3.1,
   * 3.8), and `pagesBySource` is accumulated where the source id is in scope.
   *
   * `shouldStop` is `capExceeded`, which `offer` sets the moment the ceiling is
   * breached. Feeding it in here is what turns the ceiling from "stop admitting"
   * into "stop reading": without it a breached tenant would still page through the
   * remaining collections to grow a set it has already refused. It costs nothing in
   * fidelity, because `offer` already returns early on `capExceeded` — so the
   * retain set, the fingerprint and every per-source count are identical whether
   * the reads stop or continue.
   */
  const forEachTenantDoc = async (
    sourceId: ReferenceSourceId,
    collection: string,
    handler: (data: unknown, docId: string) => void
  ): Promise<void> => {
    await forEachQueryDocPaged({
      db,
      collection,
      field: 'tenantId',
      value: tenantId,
      pageSize: firestorePageSize,
      shouldStop: () => capExceeded,
      handler,
      onPage: () => {
        pagesBySource[sourceId] += 1;
      },
    });
  };

  // ── Source 1: RTDB chat messages, two keyset-paginated levels ──────────────
  //
  // `messageIndex` is deliberately NOT the enumeration source, even though it is
  // flat, one record per message, and already used by
  // `tenantUsageRollup.collectChatActivity`. Two reasons, both disqualifying: it
  // carries NO urls, so it could only narrow which messages to fetch; and it is
  // written by a SEPARATE `writeMessageIndexRecord` call after the message write
  // (`chatMessageWriter.sendChatMessage`), so a message whose index write failed
  // has attachments and no index record — narrowing by `hasAttachments` would
  // make that message's objects look unreferenced. The same applies to
  // `conversationLatest`, `conversationSummaries`, `userConversations` and
  // `conversationClientMsgIndex`, which carry previews and counters only. The
  // authoritative source is `conversationMessages` itself.
  //
  // `orderByKey` + `startAfter` is stable under concurrent writes: push ids are
  // lexicographically increasing, so a message created during the walk either
  // sorts after the cursor and is seen, or lands behind it and is a new object
  // well inside the grace window.
  await runSource('rtdb_chat_messages', async () => {
    const conversationsRef = rtdb.ref('tenantChat').child(tenantId).child('conversationMessages');

    const offerMessage = (message: unknown): void => {
      if (message === null || typeof message !== 'object') return;

      // Legacy single-file shape at the message root, plus the transcoder's
      // `rtdbAttachmentIndex === -1` write-back of `transcodedUrl`.
      offer(readField(message, 'fileUrl'), 'rtdb_chat_messages', false);
      offer(readField(message, 'thumbnailUrl'), 'rtdb_chat_messages', false);
      offer(readField(message, 'transcodedUrl'), 'rtdb_chat_messages', false);

      // Multi-file shape.
      for (const attachment of iterateAttachments(readField(message, 'attachments'))) {
        offer(readField(attachment, 'url'), 'rtdb_chat_messages', false);
        offer(readField(attachment, 'thumbnailUrl'), 'rtdb_chat_messages', false);
        offer(readField(attachment, 'transcodedUrl'), 'rtdb_chat_messages', false);
      }

      // Giphy/Klipy stickers and gifs resolve to `foreign_bucket` today, at no
      // cost — read anyway so a future in-bucket sticker cannot become a gap.
      for (const key of ['sticker', 'gif'] as const) {
        const payload = readField(message, key);
        offer(readField(payload, 'url'), 'rtdb_chat_messages', false);
        offer(readField(payload, 'thumbnailUrl'), 'rtdb_chat_messages', false);
      }

      // Chat participants feed the profile-picture derivation (source 8).
      collectEmail(readField(message, 'sender'));
      collectEmail(readField(message, 'recipientId'));

      // A soft-deleted message has had `fileUrl`, `thumbnailUrl` and
      // `attachments` nulled by `deleteChatMessage` and therefore contributes
      // nothing. That is the lifecycle-orphan path working as intended, not a
      // gap: its objects may survive a best-effort cleanup failure, and becoming
      // candidates is the correct outcome.
    };

    // Level 2: messages within one conversation. Required, not optional — one
    // busy conversation can hold enough messages that fetching the whole node is
    // both a memory risk and a single long read.
    const walkConversation = async (conversationKey: string): Promise<void> => {
      // `conversationKey` came from the RTDB itself and is used only as an RTDB
      // child key. It is never interpolated into a bucket path.
      const messagesRef = conversationsRef.child(conversationKey);
      let messageCursor: string | null = null;
      for (;;) {
        if (capExceeded) return;
        let query = messagesRef.orderByKey();
        if (messageCursor !== null) query = query.startAfter(messageCursor);
        const page = snapshotChildren(await query.limitToFirst(messagePageSize).get());
        if (page.length === 0) return;
        for (const child of page) offerMessage(child.value);
        messageCursor = page[page.length - 1].key;
        if (page.length < messagePageSize) return;
      }
    };

    // Level 1: conversations. Only the keys are read from this page — see
    // DEFAULT_CONVERSATION_PAGE_SIZE for why the page is small.
    let conversationCursor: string | null = null;
    for (;;) {
      if (capExceeded) return;
      let query = conversationsRef.orderByKey();
      if (conversationCursor !== null) query = query.startAfter(conversationCursor);
      const keys = snapshotChildKeys(await query.limitToFirst(conversationPageSize).get());
      if (keys.length === 0) return;
      for (const conversationKey of keys) {
        await walkConversation(conversationKey);
        if (capExceeded) return;
      }
      conversationCursor = keys[keys.length - 1];
      if (keys.length < conversationPageSize) return;
    }
  });

  // ── Source 2: videoTranscodes ─────────────────────────────────────────────
  await runSource('video_transcodes', async () => {
    await forEachTenantDoc('video_transcodes', 'videoTranscodes', (data) => {
      // The OUTPUT is retained at every `status`, `'error'` included:
      // `/video/request-transcode` returns a `transcodedUrl` regardless of status
      // and repairs the status afterwards, so `status` is not a liveness signal
      // and must not be used as one.
      offer(readField(data, 'transcodedPath'), 'video_transcodes', true);
      offer(readField(data, 'transcodedUrl'), 'video_transcodes', false);

      // The ORIGINAL is retained unless its absence is EXPECTED, and
      // unconditionally while a transcode is in flight — ffmpeg may be reading
      // the file right now, and with `MAX_CONCURRENT_TRANSCODES` defaulting to 1
      // a queued job may not have started even though its document exists.
      const originalDeleted = readField(data, 'originalDeleted') === true;
      const isProcessing = readField(data, 'status') === 'processing';
      if (!originalDeleted || isProcessing) {
        offer(readField(data, 'originalPath'), 'video_transcodes', true);
        offer(readField(data, 'originalUrl'), 'video_transcodes', false);
      }
    });
  });

  // ── Source 3: sharedFiles ─────────────────────────────────────────────────
  // A share document can outlive its message, so it is an independent proof.
  await runSource('shared_files', async () => {
    await forEachTenantDoc('shared_files', 'sharedFiles', (data) => {
      const file = readField(data, 'file');
      offer(readField(file, 'url'), 'shared_files', false);
      offer(readField(file, 'thumbnailUrl'), 'shared_files', false);
    });
  });

  // ── Source 4: fees ────────────────────────────────────────────────────────
  //
  // Receipts are an ARRAY — `receipts: Array<{ url, fileName, uploadedAt, type? }>`
  // written through `useFees.updateFeeRecord` — and the field is absent from the
  // `FeeRecord` type, so every call site casts `as any` and there is no type to
  // lean on. Read defensively: a non-array value, a non-object entry and a
  // non-string `url` are each SKIPPED while enumeration of the source CONTINUES
  // (Req 6.4). Skipping explicitly rather than letting the Path_Mapper judge the
  // value keeps a stray shape from being counted as a Malformed_Reference, which
  // would abort the tenant.
  await runSource('fees', async () => {
    await forEachTenantDoc('fees', 'fees', (data) => {
      const receipts = readField(data, 'receipts');
      if (Array.isArray(receipts)) {
        for (const entry of receipts) {
          if (entry === null || typeof entry !== 'object') continue;
          const url = readField(entry, 'url');
          if (typeof url === 'string') offer(url, 'fees', false);
          // `useFees` deletes a receipt by `receipt?.storagePath || receipt?.url`,
          // so some entries carry a raw path as well. Offered as a bare path
          // because over-collecting is the safe direction.
          const storagePath = readField(entry, 'storagePath');
          if (typeof storagePath === 'string') offer(storagePath, 'fees', true);
        }
      }
      // A singular `receiptUrl` is offered purely so an older document shape
      // cannot become a gap; nothing in the codebase writes one today.
      offer(readField(data, 'receiptUrl'), 'fees', false);
    });
  });

  // ── Source 5: notices ─────────────────────────────────────────────────────
  await runSource('notices', async () => {
    await forEachTenantDoc('notices', 'notices', (data) => {
      offer(readField(data, 'imageUrl'), 'notices', false);
      offer(readField(data, 'audioUrl'), 'notices', false);
      // `imageStoragePath` is read DESPITE being absent from `types/notice.ts`:
      // the notice-delete handler in `app.ts` already reads
      // `(notice as any).imageStoragePath`, so it exists on some documents even
      // though nothing in the type system says so.
      offer(readField(data, 'imageStoragePath'), 'notices', true);
      offer(readField(data, 'audioStoragePath'), 'notices', true);
      // `linkUrl` is an arbitrary external link, never an upload, and is not read.
    });
  });

  // ── Source 6: students ────────────────────────────────────────────────────
  // EVERY status — `active`, `inactive` and `suspended` alike. The usage-rollup
  // job filters `status == 'active'` for its counts; copying that filter here
  // would delete a suspended student's photo and make reinstatement lossy.
  await runSource('students', async () => {
    await forEachTenantDoc('students', 'students', (data) => {
      offer(readField(data, 'profileImageUrl'), 'students', false);
    });
  });

  // ── Source 7: tenant branding ─────────────────────────────────────────────
  //
  // FIVE fields, not one. `app.ts` resolves branding as
  // `coerceString(data.logoUrl) ?? brandingNormalized?.logoUrl ?? null` and the
  // same for `heroImageUrl`, so the top-level and nested forms are both live, and
  // `branding.accentImageUrl` has no top-level twin. Reading only `logoUrl` would
  // report every hero and accent image as an orphan. Every string-valued leaf
  // under `branding` is then walked generically so a sixth field cannot become a
  // gap (Req 6.11).
  await runSource('tenant_branding', async () => {
    const snapshot = await db.collection('tenants').doc(tenantId).get();
    let data: unknown;
    try {
      data = snapshot.exists ? snapshot.data() : undefined;
    } catch {
      data = undefined;
    }
    const branding = readField(data, 'branding');

    // De-duplicated locally: the five named fields overlap the generic walk, and
    // `countsBySource` counts accepted references, so offering the same string
    // twice from one source would inflate that source's count for no gain.
    const candidates = new Set<string>();
    const consider = (value: unknown): void => {
      if (typeof value === 'string') candidates.add(value);
      else if (value !== undefined && value !== null) offer(value, 'tenant_branding', false);
    };
    consider(readField(data, 'logoUrl'));
    consider(readField(data, 'heroImageUrl'));
    consider(readField(branding, 'logoUrl'));
    consider(readField(branding, 'heroImageUrl'));
    consider(readField(branding, 'accentImageUrl'));
    for (const leaf of collectStringLeaves(branding)) candidates.add(leaf);

    for (const candidate of candidates) offer(candidate, 'tenant_branding', false);
  });

  // ── Source 8: profile pictures — DERIVED, not read ────────────────────────
  //
  // The one prefix where reading fields is NOT the proof.
  // `toggleProfilePictureSource` in `app/(tabs)/settings.tsx` overwrites
  // `photoURL` with the Google CDN url when a user switches back, and
  // `customImageURL` is cleared with `deleteField()` — so a user can be sitting
  // on a live uploaded avatar with NO document field pointing at it. `users` is
  // keyed by uid rather than tenant, so it cannot be enumerated per tenant at
  // all.
  //
  // The email always comes from the document FIELD, never from the document id:
  // a `tenantMemberships` id is `{tenantId}_{uid}`, a `tenantProfiles` id is
  // `{tenantId}_{sanitizeEmailKey(email)}`, and the storage path uses
  // `hashStorageKey(sanitizeStorageSegment(email))` — three different functions
  // of an email, none interchangeable.
  await runSource('profile_pictures_derived', async () => {
    // Memberships are soft-revoked, never hard-deleted (`app.ts` sets
    // `status: 'revoked'` with a `statusHistory` entry), so a departed member's
    // row survives and their avatar stays retained. ANY status is read.
    await forEachTenantDoc('profile_pictures_derived', 'tenantMemberships', (data) => {
      collectEmail(readField(data, 'email'));
    });
    await forEachTenantDoc('profile_pictures_derived', 'tenantProfiles', (data) => {
      collectEmail(readField(data, 'email'));
      // A second, independent proof — used in addition to the derivation, never
      // instead of it.
      offer(readField(data, 'photoURL'), 'profile_pictures_derived', false);
      offer(readField(data, 'customImageURL'), 'profile_pictures_derived', false);
    });

    // `emails` also holds every `sender`/`recipientId` seen during the RTDB walk
    // (source 1). If that source failed the set is partial — which is safe only
    // because the run aborts on `failedSources`.
    for (const email of emails) {
      const derived = deriveProfilePicturePath({ tenantId, email });
      // Added IRRESPECTIVE of whether any document field references it. The path
      // is logged nowhere near the email: it contains only a hash.
      if (derived) offer(derived, 'profile_pictures_derived', true, { derived: true });
    }
  });

  // ── Derived transcode outputs: close the write-before-reference window ─────
  //
  // For every chat video path now in the set, retain `{base}_h264.mp4` whether or
  // not a `videoTranscodes` document exists for it. This covers the window in
  // which the output object has been written but neither the Firestore
  // `transcodedUrl` nor the RTDB write-back has landed. A snapshot is taken
  // because `offer` mutates the set being read.
  try {
    for (const objectPath of Array.from(retainPaths)) {
      if (capExceeded) break;
      if (!isChatVideoObjectPath(objectPath, tenantId)) continue;
      offer(buildTranscodeStoragePath(objectPath), 'video_transcodes', true, { derived: true });
    }
  } catch (error) {
    // Defensive: `buildTranscodeStoragePath` is pure string arithmetic, but a
    // throw here must land in `failedSources` like any other source failure
    // rather than escaping a function documented never to throw for one.
    failedSources.push({ id: 'video_transcodes', message: describeThrownValue(error) });
  }

  // ── Fingerprint ───────────────────────────────────────────────────────────
  //
  // sha256 over the SORTED paths, NUL-separated so that concatenation cannot make
  // two different sets hash alike (`['a','bc']` vs `['ab','c']`); a NUL can never
  // occur inside an object path because the Path_Mapper rejects one. Equal sets
  // therefore yield equal fingerprints regardless of insertion order, which is
  // what makes the stale-resume check in task 6.1 meaningful (Req 13.8).
  const hash = crypto.createHash('sha256');
  for (const objectPath of Array.from(retainPaths).sort()) {
    hash.update(objectPath, 'utf8');
    hash.update('\u0000', 'utf8');
  }
  const referenceFingerprint = hash.digest('hex');

  const abortReason: ReferenceAbortReason | null =
    failedSources.length > 0
      ? 'reference_source_failed'
      : malformedReferences > 0
        ? 'malformed_reference'
        : capExceeded || retainPaths.size > maxReferences
          ? 'reference_cap_exceeded'
          : null;

  // What the set this collector built is estimated to cost (Req 8.4). An
  // over-estimate by construction — see `estimateRetainSetFootprintBytes`.
  const footprintEstimateBytes = estimateRetainSetFootprintBytes(retainPaths.size);

  // Counts, the fingerprint and the abort reason only: no object path, no
  // filename, no email address, no download token.
  console.log('[orphan_sweep] references collected', {
    tenantId,
    total: retainPaths.size,
    fingerprint: referenceFingerprint.slice(0, 8),
    countsBySource,
    pagesBySource,
    firestorePageSize,
    crossTenantReferences: crossTenantReferenceCount,
    malformedReferences,
    failedSources: failedSources.map((entry) => entry.id),
    abortReason,
    // Which ceiling bound, and the two numbers behind it. `null` for a tenant that
    // breached neither and for a tenant never large enough to be sampled.
    capBreach,
    footprintEstimateBytes,
    heapLimitBytes,
  });

  return {
    tenantId,
    retainPaths,
    referenceFingerprint,
    countsBySource,
    pagesBySource,
    derivedPaths,
    transcodeOnlyReferences: Array.from(transcodeOnlySample),
    transcodeOnlyReferenceCount,
    crossTenantReferences: Array.from(crossTenantSample),
    crossTenantReferenceCount,
    malformedReferences,
    failedSources,
    abortReason,
    capBreach,
    footprintEstimateBytes,
    heapLimitBytes,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2 — stream the listing, decide per object, settle quota, write the report
// ═════════════════════════════════════════════════════════════════════════════
//
// Phase 1 proved what is referenced. Phase 2 walks the six Managed_Category
// prefixes of one tenant and reports only the complement of that proof.
//
// Two things about this phase are load-bearing rather than stylistic:
//
//  1. **The gate comes first.** `sweepTenant` consults the abort decision Phase 1
//     resolved onto `TenantReferenceSet.abortReason` before it lists anything, and
//     on any of the three conditions it mutates nothing outside its own report
//     document. A source that failed to enumerate means some object is referenced
//     and we do not know which — so no object in that tenant is provably
//     unreferenced, and a truncated retain set is indistinguishable from a set of
//     orphans (Req 9.3–9.7).
//
//  2. **The retain set is immutable for the whole of the phase.** Nothing
//     discovered while listing may be added to it, so no ordering of the listing
//     and no page size can change a single verdict (Property 14, Req 13.1–13.3).
//     That is asserted at runtime once per page, not merely documented.

/** The five retain reasons, as a value, so `retainedByReason` is always complete. */
export type RetainReason = Extract<ObjectDisposition, { action: 'retain' }>['reason'];

export const RETAIN_REASONS = [
  'referenced',
  'within_grace',
  'age_unknown',
  'unmanaged_path',
  'quarantine_path',
] as const satisfies readonly RetainReason[];

/**
 * Every reason a tenant's run can end early. The three from Phase 1, widened
 * with the two that can only arise during Phase 2.
 */
export type SweepAbortReason =
  | ReferenceAbortReason
  | 'tenant_scope_violation'
  | 'quarantine_cap_reached';

/** Objects per `getFiles` page. */
export const DEFAULT_PAGE_SIZE = 1_000;

/** Quarantine moves per tenant per run. Bounds the blast radius of one bad run. */
export const DEFAULT_MAX_QUARANTINE_PER_TENANT = 1_000;

/** Bound on the orphan sample written to the report (Req 16.5). */
export const MAX_SAMPLE_ORPHAN_PATHS = 200;

export interface SweepConfig {
  tenantIds: string[] | 'all_active';
  /** `report` performs no mutation of any kind. `sweep` quarantines. */
  mode: 'report' | 'sweep';
  /**
   * The second, independent switch. `mode: 'sweep'` with `apply: false` behaves
   * exactly as `report` (Req 10.5), deliberately: one mistyped environment
   * variable cannot delete anything.
   */
  apply: boolean;
  graceDays: number;
  quarantineRetentionDays: number;
  pageSize: number;
  maxQuarantinePerTenant: number;
  maxReferences: number;
  /**
   * Documents per Firestore page for the seven Reference_Sources and for the
   * active-tenant query (Req 3.12, 3.13).
   *
   * OPTIONAL here and REQUIRED on `ResolvedSweepConfig`, so no existing caller of
   * this exported shape has to change while everything downstream of the resolver
   * reads a real number. Absent ⇒ `DEFAULT_FIRESTORE_PAGE_SIZE`.
   */
  firestorePageSize?: number;
  /**
   * The report-write cadence (Reqs 7.1, 7.2, 7.11, 7.12). The page interval is the
   * **upper** bound on write frequency, the time interval the **lower** bound.
   *
   * OPTIONAL here and REQUIRED on `ResolvedSweepConfig`, exactly like
   * `firestorePageSize`, so no existing caller of this exported shape has to change
   * while everything downstream of the resolver reads a real number. Absent ⇒ the
   * documented defaults from `lib/sweepScaleLimits.ts`.
   */
  reportWritePages?: number;
  reportWriteMs?: number;
  /**
   * Req 7.3 — objects quarantined since the last Report_Document write that force
   * one. **Mode-independent** (Req 7.16): there is no Report_Mode override and none
   * may be added, because `movedSinceWrite` is simply always `0` in a mode that
   * moves no object.
   *
   * Resolved to **at least 1** below, never to zero (Req 7.21). See the resolver.
   */
  quarantineWriteThreshold?: number;
  /**
   * The Heap_Limit the **runner** observed in-process at start-up (Req 8.5), in
   * bytes, forwarded so the Report_Document's `params` can record what the
   * pre-flight refusal of Req 8.6 was decided against (Req 8.13).
   *
   * OPTIONAL, and absent means "no reading was taken" rather than "the limit is
   * zero": `params.heapLimitBytes` then records the collector's own mid-collection
   * reading, or `null`. Every existing caller of this exported shape keeps
   * compiling and records `null`, which is the honest value for a run whose limit
   * nobody read.
   *
   * It is a reading rather than a knob. Nothing in this module compares against it
   * — the mid-collection guard uses the collector's own `readHeapUsage` reading, so
   * a stale start-up number cannot decide a tenant's fate — and no environment
   * variable sets it.
   *
   * `null` is accepted as well as absent, so a caller that read and got nothing
   * usable can say so rather than having to drop the field.
   */
  heapLimitBytes?: number | null;
  /**
   * The Run_Lease duration in force for this run, in milliseconds, or `null`/absent
   * when **no lease was installed** — which is the parent suite's configuration and
   * every direct invocation of this core.
   *
   * ── ECHOED, never resolved here, and that is Req 5.16 in the type system ─────
   *
   * The clamp that decides this number is `clampRunLeaseMs`, and it lives in
   * `jobs/storageOrphanSweepLease.ts`. Resolving it here would mean importing that
   * module, and the import direction is **lease → core**, never the reverse: the
   * core must stay structurally incapable of depending on the lease so that "every
   * guarantee `storage-orphan-cleanup` states holds whether or not a Run_Lease was
   * acquired" is a fact about the module graph rather than a claim in a comment.
   *
   * So the runner clamps once and passes the resolved number down, exactly as it
   * does with `heapLimitBytes` — a value observed elsewhere and recorded here
   * (Req 5.16, and the `params.leaseMs` field of task 9.2).
   */
  leaseMs?: number | null;
  /**
   * The Lease_Token of the execution writing this report, or `null` when no lease
   * was installed.
   *
   * This is the field that would have made the shipped overlap diagnosable: a
   * Report_Document whose `leaseToken` differs from the token in a run's start-up
   * log line is a report written by **another** execution. It is bookkeeping about
   * this job and no part of it is a credential — holding the token grants no access
   * to anything; it only identifies which execution may renew or release the lease
   * (see `RunLeaseDoc` in the lease module), which is also why the runner may log
   * it.
   *
   * Echoed for the same reason `leaseMs` is.
   */
  leaseToken?: string | null;
  /** Re-run a tenant already recorded `completed`. */
  force?: boolean;
  runnerId: string;
  /** Injected ONCE per run so a multi-hour sweep uses one grace cutoff throughout. */
  nowMs?: number;
  /**
   * Minted once per run when absent.
   *
   * Supplied by the **runner** in production since task 9.2, not only by tests: the
   * Run_Lease document records the run's Sweep_Id so a Report_Document and the lease
   * that produced it can be tied together, and the lease is acquired before this core
   * is entered (Req 5.1) — so the id has to exist before then. The runner mints it
   * with the exported `mintSweepId` and passes the same value here, which is what
   * makes the lease's `sweepId` and every report's `sweepId` the same string.
   */
  sweepId?: string;
}

/** `SweepConfig` with the once-per-run values resolved. */
export interface ResolvedSweepConfig extends SweepConfig {
  nowMs: number;
  sweepId: string;
  /** Resolved through `normalisePositiveInt`, so never zero and never non-finite. */
  firestorePageSize: number;
  /** Resolved (Req 7.12). Recorded in the Report_Document's `params` (Req 7.13). */
  reportWritePages: number;
  reportWriteMs: number;
  /**
   * Resolved, and **floored at 1** (Req 7.21) — see the resolver in
   * `runStorageOrphanSweep` for why the floor is not belt-and-braces.
   */
  quarantineWriteThreshold: number;
  /**
   * The runner's start-up Heap_Limit reading, or `null` when no usable reading was
   * supplied (Req 8.13). Resolved to `null` rather than left `undefined` so the
   * Report_Document records the field on every write — an absent field and an
   * unreadable limit are different facts, and only the second is worth a `null`.
   */
  heapLimitBytes: number | null;
  /**
   * The Run_Lease duration in force, or `null` when no lease was installed
   * (task 9.2). Resolved to `null` rather than left `undefined` for the same reason
   * `heapLimitBytes` is: the Report_Document then records the field on every write,
   * and "no lease was installed" is a fact worth recording rather than an absence.
   */
  leaseMs: number | null;
  /** The writing execution's Lease_Token, or `null` when no lease was installed. */
  leaseToken: string | null;
  graceCutoffMs: number;
  /** `mode === 'sweep' && apply === true` — the ONLY combination that mutates. */
  applyMode: boolean;
}

export interface TenantSweepResult {
  tenantId: string;
  /**
   * ── `'failed'` is an ADDITIVE widening, and it is not `'in_progress'` ───────
   *
   * `'failed'` is a Tenant_Sweep_Failure: this tenant's sweep raised rather than
   * reaching `completed` or `aborted`, and `runStorageOrphanSweep`'s per-tenant
   * confinement recorded it and carried on with the next tenant (Req 1.1, 1.7,
   * 9.14). The recorded meaning of `'completed'`, `'aborted'` and `'in_progress'`
   * is unchanged, and `sweepTenant` itself still returns only `'completed'` or
   * `'aborted'` — the confinement is the sole producer of `'failed'`.
   *
   * Reusing `'in_progress'` would have been free in the type system and actively
   * misleading to the operator the confinement exists for: a Report_Document
   * reading `in_progress` for a tenant that failed reads as "a run is still
   * going", which is the one thing that tenant is not doing.
   *
   * Every site that reads a *recorded* status discriminates on equality with
   * `'completed'` — the `force`-false early return, `freshStart`, and
   * `countersFromProgress` (which does not branch on status at all) — so a
   * recorded `'failed'` inherits the persisted cursor and counters and re-lists,
   * exactly as `'in_progress'` does (Req 1.13, 1.14, 9.13). Rewriting any of
   * those three as an inequality against `'in_progress'` would treat a `'failed'`
   * document as recorded-and-done and skip that tenant forever. Do not.
   */
  status: 'completed' | 'aborted' | 'in_progress' | 'failed';
  abortReason?: SweepAbortReason;
  mode: 'report' | 'sweep';
  applied: boolean;
  sweepId: string;
  objectsScanned: number;
  retainedByReason: Record<RetainReason, number>;
  orphanCount: number;
  orphanBytes: number;
  quarantinedCount: number;
  quarantinedBytes: number;
  quarantineFailures: number;
  /** Bounded sample so an operator can eyeball it before applying. */
  sampleOrphanPaths: string[];
  /** References whose target is absent from the listing. Reported only. */
  danglingReferenceCount: number;
  /**
   * Non-derived retain paths actually seen in the listing. Carried on the result
   * and the report because it is the term a resumed run needs in order not to
   * count everything it has not yet reached as dangling.
   */
  fieldReferencesObserved: number;
  usageBytesBefore: number | null;
  usageBytesAfter: number | null;
  /** Set when the recompute or its write failed; the run is still `completed`. */
  usageError?: string;
  /**
   * The coerced thrown value, on a `status: 'failed'` result and nowhere else
   * (Req 1.3). Optional, so every existing field and every existing constructor
   * of this interface is unchanged (Req 9.7).
   *
   * Coerced through `describeThrownValue`, so a thrown `null`, a symbol and an
   * object whose `message` getter throws each yield a non-empty, length-bounded
   * string (Req 1.2). It is the operator's only diagnostic for a tenant that was
   * not swept, and it may carry whatever the thrower put in it — which is exactly
   * why it never reaches a metric label (Req 10.2).
   */
  failureMessage?: string;
  /**
   * WHICH reference ceiling bound, on a result whose `abortReason` is
   * `'reference_cap_exceeded'` and nowhere else (Req 8.9).
   *
   * Optional, so every existing field and every existing constructor of this
   * interface is unchanged (Req 9.7). Purely DIAGNOSTIC: `'configured'` and
   * `'memory_guard'` abort identically and quarantine nothing, which is exactly why
   * `SweepAbortReason` keeps its five values rather than gaining a sixth (Req 8.10,
   * 8.12) — the distinction an operator needs is "which limit did I hit", and that
   * is a field, not an outcome.
   */
  capBreach?: 'configured' | 'memory_guard';
  /**
   * Report_Document writes this process issued for this tenant, including the
   * terminal one (Req 7.8, 7.18).
   *
   * Optional, so every existing field and every existing constructor of this
   * interface is unchanged (Req 9.7). What an operator reads it for: a count far
   * below the tenant's page count is the evidence that batching is in force, and a
   * count equal to the page count means the cadence collapsed — see
   * `params.quarantineWriteThreshold`, whose recorded `0` would be the cause.
   */
  reportWrites?: number;
}

/**
 * The bucket surface Phase 2 actually uses. Declared structurally rather than
 * taken from `@google-cloud/storage` for two reasons: it keeps this module's
 * firebase-admin import type-only, and it makes the recording fakes in
 * `storageOrphanSweep.reportNoMutation.property.test.ts` legitimate stand-ins
 * rather than partial mocks of a much larger interface — the property there is
 * asserted over the set of methods invoked, which is only meaningful if the set
 * of methods available is known.
 */
export interface SweepBucket {
  name?: string;
  getFiles(options: {
    prefix?: string;
    pageToken?: string;
    maxResults?: number;
    autoPaginate?: boolean;
  }): Promise<unknown[]>;
  /**
   * OPTIONAL, and optional on purpose. Phase 2's listing needs only `getFiles`,
   * so a report-mode caller can hand over a bucket that has no way to name a
   * mutator at all; only `quarantineObject` and `restoreFromQuarantine` reach for
   * this, and each refuses to proceed without it rather than silently reporting a
   * move it could not perform.
   */
  file?(objectPath: string): SweepObjectHandle;
}

/**
 * The object surface the quarantine move and its inverse use — copy, verify,
 * delete, and an existence check — and nothing else.
 *
 * Deliberately four methods wide, and deliberately not `@google-cloud/storage`'s
 * `File`. Property 6 is stated over the SET of methods invoked, which is only
 * meaningful if the set of methods available is known; and every return type is
 * `Promise<unknown>` because the real client resolves `[metadata, apiResponse]`
 * tuples whose shapes this module treats as untrusted input like every other read
 * value.
 */
export interface SweepObjectHandle {
  name?: string;
  copy(destination: unknown): Promise<unknown>;
  getMetadata(): Promise<unknown>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  exists(): Promise<unknown>;
}

/**
 * The seam `quarantineObject` (below) plugs into.
 *
 * It stays a seam rather than a direct call for the reason the plan's ordering
 * exists: report mode was proven to mutate nothing BEFORE any code that can move
 * an object landed, and a caller that installs no mover therefore still cannot
 * move one. `runStorageOrphanSweep` refuses to start in apply mode without a
 * mover rather than reporting a `completed` destructive run that quietly moved
 * nothing.
 *
 * `quarantineObject` satisfies this type exactly, so wiring apply mode is
 * `quarantineObject: quarantineObject`.
 */
export type QuarantineMover = (args: {
  bucket: SweepBucket;
  /** For the manifest entry, which is written BEFORE the delete (Req 11.5). */
  db: Firestore;
  tenantId: string;
  sweepId: string;
  objectPath: string;
  bytes: number | null;
  /** Drives the manifest's `retainedUntil`; defaults to the documented 7 days. */
  quarantineRetentionDays?: number;
  /** The run's single `nowMs`, so every manifest entry of one run agrees. */
  nowMs?: number;
}) => Promise<{ ok: true; bytes: number | null } | { ok: false; message: string }>;

/** Resume state persisted on the Report_Document. `null` once complete. */
export interface SweepResumeState {
  prefixIndex: number;
  pageToken: string | null;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The six listing prefixes for one tenant, derived from the shared
 * Managed_Category tuple so a seventh category cannot be swept before its
 * reference source exists (Req 6.15).
 *
 * `tenantId` comes from the run's configured list or the active-tenant query —
 * never from a value read out of a record (Req 4.11).
 */
export function listingPrefixesForTenant(tenantId: string): string[] {
  return STORAGE_TENANT_CATEGORIES.map((category) => `${category}/${tenantId}/`);
}

/**
 * An epoch-ms from a GCS metadata timestamp, which is an RFC 3339 string in
 * practice but is treated as `unknown` like every other read value. Anything
 * unusable is `null`, which the Decision_Function reads as `age_unknown` and
 * therefore RETAINS.
 */
export function parseEpochMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * `Last_Touched` = **max(`timeCreated`, `updated`)**, or `null` when neither
 * parses (Req 2.2).
 *
 * Taking the maximum is the conservative direction: a recently touched object
 * reads as YOUNG and is therefore retained. It is also exactly what makes an
 * `upload-idempotency` retry safe — that retry overwrites a deterministic path,
 * which creates a new GCS generation with a fresh `timeCreated`, so the object
 * re-enters the grace window instead of inheriting the first write's age.
 */
export function resolveLastTouchedMs(metadata: unknown): number | null {
  const created = parseEpochMs(readField(metadata, 'timeCreated'));
  const updated = parseEpochMs(readField(metadata, 'updated'));
  if (created === null) return updated;
  if (updated === null) return created;
  return Math.max(created, updated);
}

/** `Number(metadata.size)` or `null`. Reporting only — never a retain input. */
export function parseObjectBytes(metadata: unknown): number | null {
  const raw = readField(metadata, 'size');
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Whether an object under `profile-pictures/{tenantId}/` has a filename this
 * codebase does not mint (Req 7.9).
 *
 * `profile-pictures/` is the one prefix retained by DERIVATION rather than by
 * field reading, so the derivation is the only description of what belongs there.
 * A name it does not describe — a nested path, a different extension, anything
 * that is not `hashStorageKey`'s twenty hex characters plus `.jpg` — is not a
 * proven orphan, and an undescribed object is retained.
 */
function isUndescribedProfilePicture(objectPath: string, tenantId: string): boolean {
  const prefix = `profile-pictures/${tenantId}/`;
  if (!objectPath.startsWith(prefix)) return false;
  return !isDerivedProfilePictureFilename(objectPath.slice(prefix.length));
}

/**
 * The Decision_Function, plus the one Phase-2-local retain rule that needs
 * knowledge the pure function does not have.
 *
 * The override is applied ONLY to a disposition that would otherwise be
 * `report`. Both readings of Req 7.9 retain the object — the action is identical
 * — and they differ only in the recorded reason, so an object that is provably
 * referenced still reports the more informative `referenced`. That matches
 * `decideObjectDisposition`'s own ordering rationale, where `age_unknown` is
 * evaluated last so a referenced object with unreadable metadata still reports
 * `referenced` rather than hiding behind its missing timestamps.
 */
export function resolveObjectDisposition(
  facts: ObjectFacts,
  context: { tenantId: string; retainPaths: ReadonlySet<string>; graceCutoffMs: number }
): ObjectDisposition {
  const disposition = decideObjectDisposition(facts, context);
  if (
    disposition.action === 'report' &&
    isUndescribedProfilePicture(facts.objectPath, context.tenantId)
  ) {
    return { action: 'retain', reason: 'unmanaged_path' };
  }
  return disposition;
}

function emptyRetainedByReason(): Record<RetainReason, number> {
  return RETAIN_REASONS.reduce(
    (acc, reason) => {
      acc[reason] = 0;
      return acc;
    },
    {} as Record<RetainReason, number>
  );
}

function toNonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A `Date` from either a `Date` or a Firestore `Timestamp`; `null` otherwise. */
function coerceToDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const toDate = readField(value, 'toDate');
  if (typeof toDate === 'function') {
    try {
      const converted = (value as { toDate(): unknown }).toDate();
      return converted instanceof Date && Number.isFinite(converted.getTime()) ? converted : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && out.length < limit) out.push(entry);
  }
  return out;
}

// ─── The per-tenant run ──────────────────────────────────────────────────────

/**
 * Mutable counters for one tenant's run, inherited across a resume.
 *
 * Exported only so `assertSweepInvariants` — which is exported so the accounting
 * identity can be asserted directly rather than only through a run that happens to
 * satisfy it — has a nameable parameter type.
 */
export interface SweepCounters {
  objectsScanned: number;
  retainedByReason: Record<RetainReason, number>;
  orphanCount: number;
  orphanBytes: number;
  quarantinedCount: number;
  quarantinedBytes: number;
  quarantineFailures: number;
  /**
   * Retain paths observed in the listing that were NOT derived — the subtrahend
   * of the dangling-reference difference below. Persisted so a resumed run does
   * not conclude that everything it has not yet reached is dangling.
   */
  fieldReferencesObserved: number;
  sampleOrphanPaths: string[];
}

function emptyCounters(): SweepCounters {
  return {
    objectsScanned: 0,
    retainedByReason: emptyRetainedByReason(),
    orphanCount: 0,
    orphanBytes: 0,
    quarantinedCount: 0,
    quarantinedBytes: 0,
    quarantineFailures: 0,
    fieldReferencesObserved: 0,
    sampleOrphanPaths: [],
  };
}

function countersFromProgress(data: Record<string, unknown>): SweepCounters {
  const retainedByReason = emptyRetainedByReason();
  const recorded = data.retainedByReason;
  if (recorded !== null && typeof recorded === 'object') {
    for (const reason of RETAIN_REASONS) {
      retainedByReason[reason] = toNonNegativeInt((recorded as Record<string, unknown>)[reason]);
    }
  }
  return {
    objectsScanned: toNonNegativeInt(data.objectsScanned),
    retainedByReason,
    orphanCount: toNonNegativeInt(data.orphanCount),
    orphanBytes: toNonNegativeInt(data.orphanBytes),
    quarantinedCount: toNonNegativeInt(data.quarantinedCount),
    quarantinedBytes: toNonNegativeInt(data.quarantinedBytes),
    quarantineFailures: toNonNegativeInt(data.quarantineFailures),
    fieldReferencesObserved: toNonNegativeInt(data.fieldReferencesObserved),
    sampleOrphanPaths: toStringArray(data.sampleOrphanPaths, MAX_SAMPLE_ORPHAN_PATHS),
  };
}

export interface SweepTenantArgs {
  bucket: SweepBucket;
  db: Firestore;
  tenantId: string;
  references: TenantReferenceSet;
  config: ResolvedSweepConfig;
  /**
   * The mover — `quarantineObject` below. Report mode never calls it, and apply
   * mode without one is refused by `runStorageOrphanSweep` rather than reported as
   * a `completed` destructive run that moved nothing.
   */
  quarantineObject?: QuarantineMover;
  /**
   * Apply mode's `storageBytes:{tenantId}` cache bust (Req 14.5).
   *
   * Injected rather than imported: the live-count cache is a per-process `Map`
   * inside `app.ts`, and this job runs in a *different* process (a Cloud Run
   * job), so there is nothing in-process to invalidate and importing `app.ts`
   * would pull `express` and the whole route surface into the job image. The seam
   * exists so the requirement is expressible and testable; wiring it to a real
   * invalidation is the runner's concern, not this module's.
   */
  invalidateLiveCount?: (cacheKey: string) => void | Promise<void>;
  /**
   * The LIVE clock, defaulting to `Date.now`, read by the report-write scheduler
   * and by **nothing else** (Req 7.2).
   *
   * ── Why it is named `now` and not `clock`, and why that matters ─────────────
   *
   * `config.nowMs` is frozen for the whole run **on purpose**: the parent design
   * freezes it so a multi-hour sweep cannot have its Grace_Cutoff drift underneath
   * it and start judging objects it retained an hour earlier. This seam is the
   * opposite thing — a live reading, needed because the Report_Write_Time_Interval
   * is a *lower* bound on write frequency and a frozen clock would make
   * `msSinceWrite` permanently `0`.
   *
   * The name is deliberately the narrow one. A future edit that reached for this
   * seam to compute a cutoff — `graceCutoffMs`, a `retainedUntil`, a manifest
   * timestamp — would silently break the parent spec's Property 5, because two
   * pages of one listing would then be judged against two different cutoffs and
   * nothing would fail loudly. Everything time-like that must agree across the run
   * reads `config.nowMs`; only the cadence reads this.
   */
  now?: () => number;
  /**
   * `assertSweepInvariants`, injectable so Req 7.10's cadence is COUNTABLE.
   *
   * ── Why a seam rather than a spy on the export ─────────────────────────────
   *
   * Req 7.10 is "the per-page invariant check is evaluated on every listing page,
   * independently of the Report_Document write interval" — a claim about a *count*,
   * not about an outcome, and the check is deliberately side-effect-free unless it
   * throws. The call below resolves the module-local declaration, so a spy on the
   * module's export never sees it; without this seam the only observable would be
   * the page count, which is the very thing the claim relates the count to.
   *
   * Same posture and same reason as `invalidateLiveCount`: the seam exists so the
   * requirement is expressible and testable. Nothing in production passes it — the
   * runner does not, `runStorageOrphanSweep` only forwards what it was given — so
   * the default IS the behaviour, and a replacement that swallowed a violation
   * could only ever be installed by a test.
   *
   * Do not use it to *change* the check. It is `typeof assertSweepInvariants` so a
   * substitute must accept exactly the same five arguments, and Property 8 counts
   * calls while delegating to the real function, which is what keeps the count
   * honest about the check that actually ran.
   */
  assertInvariants?: typeof assertSweepInvariants;
}

/**
 * Sweep one tenant: gate, list, decide, settle quota, report.
 *
 * Preconditions: `references` came from `collectTenantReferenceSet` for this same
 * `tenantId`; `config.nowMs` and `config.sweepId` were captured once for the run.
 *
 * Postconditions:
 *  - in report mode (and in `mode: 'sweep'` with `apply: false`) the ONLY write is
 *    the Report_Document under `storageMaintenanceJobs/`;
 *  - exactly one `estimateTenantStorageBytes` recompute per tenant per run, in
 *    both modes, written to `tenantStorageUsage` only in apply mode;
 *  - the resume cursor is persisted only AFTER the corresponding page's work has
 *    completed, so a mid-run failure leaves the last SUCCESSFUL cursor intact;
 *  - `retainPaths` is unchanged throughout.
 */
export async function sweepTenant(args: SweepTenantArgs): Promise<TenantSweepResult> {
  const { bucket, db, references, config } = args;
  const tenantId = args.tenantId;
  const reportRef = db.doc(tenantReportPath(tenantId));
  // See `SweepTenantArgs.now`: the LIVE clock, for the write cadence and nothing
  // else. `config.nowMs` stays the frozen one every verdict is judged against.
  const now = args.now ?? Date.now;
  // See `SweepTenantArgs.assertInvariants`. The default is the behaviour; the seam
  // exists so Property 8 can COUNT the per-page evaluations Req 7.10 requires.
  const assertInvariants = args.assertInvariants ?? assertSweepInvariants;
  const metricLabels: SweepMetricLabels = { tenant_id: tenantId, mode: config.mode };

  // One of the two alerted signals (Req 16.13), emitted BEFORE the gate so an
  // aborted tenant still reports it: a cross-tenant reference is excluded from the
  // retain set and the run continues, so it is a data-integrity signal that is
  // independent of how this tenant's run ends. Phase 1 found it; this is where the
  // report counter for it is written, so this is where the metric moves. The count
  // is unbounded while the recorded sample is capped — a truncated sample must not
  // silence the alert.
  emitSweepMetric(
    metricNames.storageOrphanSweepCrossTenantReferences,
    metricLabels,
    references.crossTenantReferenceCount,
    'WARNING'
  );

  // ── THE GATE ───────────────────────────────────────────────────────────────
  //
  // Nothing below runs on partial knowledge. Phase 1 already resolved the three
  // conditions onto `abortReason` so this caller cannot forget one (Req 9.11);
  // the precedence is a failed source, then a malformed reference, then a
  // breached ceiling. The retain set is NEVER truncated to fit the ceiling —
  // a truncated retain set is indistinguishable from a set of orphans.
  //
  // "Mutate nothing" here means nothing outside `storageMaintenanceJobs/`: no
  // bucket method, no Realtime Database write, no application collection, in
  // either mode. The partial Report_Document IS written, because a run that
  // stopped without saying so is worse than one that says why (Req 9.10).
  const gateReason: SweepAbortReason | null =
    references.abortReason ??
    (references.retainPaths.size > config.maxReferences ? 'reference_cap_exceeded' : null);

  // WHICH ceiling bound (Req 8.9), for the result and the report. The collector's own
  // label when it set one; `'configured'` when THIS gate's own `size > maxReferences`
  // comparison is what caught it, which is the only way a cap abort arrives here
  // unlabelled. `undefined` for the other four abort reasons: `capBreach` is
  // meaningful only alongside `reference_cap_exceeded`.
  const gateCapBreach: 'configured' | 'memory_guard' | undefined =
    gateReason === 'reference_cap_exceeded' ? (references.capBreach ?? 'configured') : undefined;

  if (gateReason) {
    const result: TenantSweepResult = {
      tenantId,
      status: 'aborted',
      abortReason: gateReason,
      mode: config.mode,
      applied: config.applyMode,
      sweepId: config.sweepId,
      ...emptyCounters(),
      danglingReferenceCount: 0,
      usageBytesBefore: null,
      usageBytesAfter: null,
      capBreach: gateCapBreach,
      // The gate's own write, and the only one a pre-listing abort issues.
      reportWrites: 1,
    };
    await writeTenantReport({
      reportRef,
      references,
      config,
      status: 'aborted',
      abortReason: gateReason,
      capBreach: gateCapBreach ?? null,
      resume: null,
      counters: emptyCounters(),
      danglingReferenceCount: 0,
      usageBytesBefore: null,
      usageBytesAfter: null,
      startedAt: new Date(),
      completed: false,
      lastError: null,
      reportWrites: 1,
    });
    console.log('[orphan_sweep] tenant aborted before listing', {
      tenantId,
      mode: config.mode,
      abortReason: gateReason,
      capBreach: gateCapBreach ?? null,
      failedSources: references.failedSources.map((entry) => entry.id),
      malformedReferences: references.malformedReferences,
      references: references.retainPaths.size,
    });
    // The OTHER alerted signal (Req 16.12). One of exactly two sites that move the
    // abort counter — this one for the pre-listing gate, and the post-loop site for
    // the two Phase 2 aborts — so a tenant's abort is counted once.
    emitSweepMetric(
      metricNames.storageOrphanSweepAborted,
      { ...metricLabels, abort_reason: gateReason },
      1,
      'WARNING'
    );
    emitSweepMetric(metricNames.storageOrphanSweepRuns, { ...metricLabels, outcome: 'aborted' }, 1);
    return result;
  }

  // The retain set is IMMUTABLE from here to the end of this function. Nothing
  // discovered while listing may add to it or remove from it — that is what makes
  // a disposition a function of `(objectPath, lastTouchedMs, retainPaths,
  // graceCutoffMs)` alone and forbids the tempting optimisation of crediting a
  // reference noticed mid-listing (Property 14). Asserted once per page below.
  const retainPaths: ReadonlySet<string> = references.retainPaths;
  const retainPathsSizeAtStart = retainPaths.size;
  const derivedPaths: ReadonlySet<string> = references.derivedPaths ?? new Set<string>();

  const graceCutoffMs = config.graceCutoffMs;

  // ── Resume state ───────────────────────────────────────────────────────────
  const progressSnapshot = await reportRef.get();
  const progressData: Record<string, unknown> = progressSnapshot.exists
    ? ((progressSnapshot.data() ?? {}) as Record<string, unknown>)
    : {};
  const recordedStatus = typeof progressData.status === 'string' ? progressData.status : null;
  const force = config.force === true;

  // A tenant already recorded `completed` is an exact no-op without `force`: the
  // recorded result is returned and nothing is re-listed and nothing re-written
  // (Req 13.9).
  if (recordedStatus === 'completed' && !force) {
    const counters = countersFromProgress(progressData);
    // "The job ran and this tenant needed nothing" is a fact worth seeing; the
    // recorded counters are NOT re-emitted, because they belong to the run that
    // earned them and re-reporting them would inflate every subsequent scheduled
    // run by the whole backlog it deliberately skipped.
    emitSweepMetric(
      metricNames.storageOrphanSweepRuns,
      { ...metricLabels, outcome: 'completed' },
      1
    );
    return {
      tenantId,
      status: 'completed',
      mode: (progressData.mode === 'sweep' ? 'sweep' : 'report') as 'report' | 'sweep',
      applied: progressData.applied === true,
      sweepId: typeof progressData.sweepId === 'string' ? progressData.sweepId : config.sweepId,
      ...counters,
      danglingReferenceCount: toNonNegativeInt(progressData.danglingReferenceCount),
      usageBytesBefore: toNullableNumber(progressData.usageBytesBefore),
      usageBytesAfter: toNullableNumber(progressData.usageBytesAfter),
      // An exact no-op re-writes nothing, so this process issued no report write.
      reportWrites: 0,
    };
  }

  // A stale reference set is a false-positive generator, so the LISTING resumes
  // but the reference set never does: it is rebuilt from the sources on every run
  // (Req 13.4), and a fingerprint mismatch discards the cursor and restarts from
  // the first prefix (Req 13.7). Without that, a run interrupted on Monday and
  // resumed on Wednesday would judge Wednesday's bucket against Monday's idea of
  // what is referenced.
  const fingerprintMatches =
    typeof progressData.referenceFingerprint === 'string' &&
    progressData.referenceFingerprint === references.referenceFingerprint;
  const staleFingerprint = progressSnapshot.exists && !fingerprintMatches;
  const freshStart = force || recordedStatus === 'completed' || staleFingerprint;

  const counters = freshStart ? emptyCounters() : countersFromProgress(progressData);

  /**
   * The counters this process INHERITED from an interrupted earlier attempt.
   *
   * Subtracted from the final counters to give the per-metric delta the log lines
   * carry (see the Observability block above). The in-process counters below move
   * object by object and are therefore already deltas by construction; without
   * this baseline the log lines would re-report the earlier attempt's objects and
   * make a resumed run look like a busier one.
   */
  const inheritedCounters: SweepCounters = {
    ...counters,
    retainedByReason: { ...counters.retainedByReason },
    sampleOrphanPaths: [],
  };

  let prefixIndex = 0;
  let pageToken: string | null = null;
  if (!freshStart) {
    const resume = progressData.resume;
    if (resume !== null && typeof resume === 'object') {
      const recordedIndex = toNonNegativeInt((resume as Record<string, unknown>).prefixIndex);
      const recordedToken = (resume as Record<string, unknown>).pageToken;
      prefixIndex = Math.min(recordedIndex, STORAGE_TENANT_CATEGORIES.length);
      pageToken = typeof recordedToken === 'string' && recordedToken ? recordedToken : null;
    }
  }

  if (staleFingerprint) {
    console.log('[orphan_sweep] reference fingerprint changed; restarting the listing', {
      tenantId,
      mode: config.mode,
    });
  }

  // Preserved across a resume so `startedAt` means "when this sweep of this
  // tenant began", not "when the last attempt began". Accepts both a `Date` and a
  // Firestore `Timestamp`, since the SDK reads back what it stored as the latter.
  const startedAt = (!freshStart ? coerceToDate(progressData.startedAt) : null) ?? new Date();

  const prefixes = listingPrefixesForTenant(tenantId);
  const decisionContext = { tenantId, retainPaths, graceCutoffMs };

  let abortReason: SweepAbortReason | null = null;

  /**
   * Object paths already moved by THIS process, so a candidate is quarantined at
   * most once within one Sweep_Id (Req 13.11). Process-scoped on purpose: a
   * Sweep_Id is minted once per run, so "within one Sweep_Id" and "within one
   * process" are the same window, and a second run gets a new Sweep_Id folder —
   * which is what makes a repeated move idempotent rather than destructive
   * (Req 11.20).
   */
  const quarantinedInThisRun = new Set<string>();

  /**
   * Report_Document writes this process has issued for this tenant (Req 7.8).
   *
   * Incremented by `persist` itself rather than by its callers, so the number the
   * document records is the number of writes that reached Firestore — including the
   * two terminal writes below, which do not route through `maybeWrite`.
   */
  let reportWrites = 0;

  const persist = async (
    status: 'in_progress' | 'completed' | 'aborted',
    resume: SweepResumeState | null,
    extra?: { danglingReferenceCount?: number; abortReason?: SweepAbortReason }
  ): Promise<void> => {
    reportWrites += 1;
    await writeTenantReport({
      reportRef,
      references,
      config,
      status,
      abortReason: extra?.abortReason ?? null,
      resume,
      counters,
      danglingReferenceCount: extra?.danglingReferenceCount ?? null,
      usageBytesBefore: null,
      usageBytesAfter: null,
      startedAt,
      completed: false,
      lastError: null,
      partialFieldsOnly: status === 'in_progress',
      reportWrites,
    });
  };

  // ══ The report-write cadence ═══════════════════════════════════════════════
  //
  // Three **since-the-last-write** accumulators, one per configured bound, all
  // three reset or rebased after EVERY write. That symmetry is what makes Req 7.8's
  // bound a consequence of `shouldWriteTenantReport` rather than of this call site.
  //
  // ── Why the moved-object count exists at all: TWO defects, and one trigger ──
  //
  // **Defect 1 — a lagging persisted counter reopens the per-tenant Quarantine
  // ceiling.** The worked trace: ceiling 1000, page interval 10, apply mode, 100
  // objects moved per page. Nine pages move 900 objects. The process crashes. The
  // persisted `quarantinedCount` is still `0`, because no write has happened yet.
  // The 900 moved objects are gone from the listing — they are under
  // `_orphan-quarantine/` now — so the resumed run finds the NEXT 1000 candidates
  // and moves them from an inherited base of `0`. Total: **1900 objects against a
  // documented ceiling of 1000.**
  //
  // With the threshold at its default of 25, the same trace stops at the 25th move
  // of page 1: the threshold is reached, the Report_Document is written, and at no
  // instant does the persisted `quarantinedCount` lag the objects actually moved by
  // 25 or more (Req 7.3). The crash-and-resume pair therefore moves at most
  // **`ceiling + 24`** rather than `2 x ceiling` — an overshoot bounded by the
  // THRESHOLD rather than by a whole write interval's worth of moves (Req 7.22).
  // The inherited counter is what closes Defect 1, and a lagging inherited counter
  // reopens it.
  //
  // **Defect 2 — "any page that moved an object" bounds the write count by nothing
  // useful, and that is why the trigger counts OBJECTS rather than PAGES.** Forcing
  // a write after *any page that quarantined one or more objects* is the obvious
  // reading of the exception and it is a defect: bounding the resulting write count
  // by "the number of pages that moved an object" is true and useless, because that
  // count is itself bounded only by the ceiling. At the shipped ceiling default of
  // 1000, a listing whose orphans are spread **one per page** produces roughly
  // **1000 forced writes to a single Firestore document** — exactly the failure this
  // batching exists to eliminate, reintroduced by the mechanism meant to make
  // batching safe. Report_Mode is safe from it only incidentally, because it moves
  // nothing and the exception is unreachable there; Apply_Mode against a backlog is
  // the common case, not a rare one.
  //
  // **What protects the per-page trigger today is incidental, not designed.** A
  // quarantining page has necessarily performed at least one copy -> `getMetadata`
  // -> manifest write -> delete before its report write, so roughly **150–600 ms**
  // of forced work separates two writes. On a page moving 100 objects that is
  // seconds. On a page moving **exactly one small object** it is **2–6 report writes
  // per second** against Firestore's guidance of roughly **one sustained write per
  // second per document** — contention and latency on the very document the resume
  // cursor lives on. A delay produced by unrelated I/O is not a write-rate bound.
  //
  // **An artificial delay between writes was considered and REJECTED** (Req 7.23).
  // A sleep slows the sweep in order to protect a write, and it makes a run's
  // wall-clock duration depend on a Firestore write quota — a job whose
  // `timeoutSeconds` budget is spent waiting is a job that sweeps fewer tenants.
  // Bounding the lag in objects removes the exposure without buying it back in
  // latency, so **insert no delay** anywhere in this write path.
  //
  // ── The resulting bound, and why it is strictly better rather than a trade ───
  //
  // The writes attributable to moves are at most **`ceil(M / T)`** for `M` objects
  // moved at threshold `T`, which at the ceiling is at most `ceiling / threshold` —
  // **independently of the listing page size and of how the moved objects are
  // distributed across pages** (Req 7.9). Both consequences beat the per-page
  // trigger rather than trading against it: the write count falls, *and* the
  // crash-then-resume overshoot falls from a whole interval's moves to the
  // threshold.
  //
  // Worked comparison, because it is the clearest statement of the fix: a
  // **1000-page listing at the shipped ceiling of 1000 with orphans one per page**
  // gives `ceil(1000/25) = ` **40** move-attributable writes under the threshold,
  // against **1000** under the rejected per-page trigger. At the first cautious
  // apply ceiling of 25 it gives exactly **one** write on account of moves, not 25 —
  // which is what Req 7.19 fixes the default to 25 for.
  //
  // Report_Mode moves nothing, so `movedSinceWrite` is always `0` there and its
  // write count is purely interval-driven — which is the case the million-object
  // tenant is actually in, and the case this batching exists for.
  let pagesSinceWrite = 0;
  let movedSinceWrite = 0;
  let lastWriteAtMs = now();

  /**
   * ONE procedure, TWO call sites — the per-object loop and the page boundary — so
   * `shouldWriteTenantReport` stays the only place the cadence is decided and the
   * two sites cannot drift into two cadences.
   *
   * The cursor a write persists is ALWAYS `pageToken` as it currently stands: the
   * token for the last **fully completed** page. A mid-page threshold write
   * therefore re-persists that UNADVANCED cursor alongside counters that already
   * include the moves made so far on the page in flight (Reqs 7.6, 7.7, 7.24). The
   * counters may **lead** the cursor and can never **lag** it, and that asymmetry is
   * the safe one: a resume re-examines a partially handled page, finds its
   * already-moved objects gone from the listing, and inherits a `quarantinedCount`
   * that is exact rather than short. Re-examination costs nothing either way — a
   * quarantined object is no longer in the listing, and `quarantinedInThisRun`
   * skips a re-offer without consuming ceiling budget. The threshold governs
   * **when** a write occurs and governs **no ordering guarantee**.
   *
   * `status: 'in_progress'` is CORRECT here and stays: a run that is mid-listing
   * genuinely is still going. Only the catch's terminal write records `'failed'`,
   * so the two never compete for the field.
   *
   * `terminal` is never passed `true` by either call site, and that is by design
   * rather than an oversight: Req 7.5's three terminal writes — the two
   * `persist('aborted', …)` calls in the per-object loop, the final
   * `writeTenantReport` below, and the catch's `lastError`-only `set` — are
   * **unconditional**. A terminal outcome is one of the three enumerated exceptions,
   * so the scheduler would answer `true` regardless and routing those writes through
   * here would add nothing but a way for one of them to be skipped. The parameter
   * exists so this procedure's argument list *is* the scheduler's `ReportWriteEvent`,
   * which is what makes "the cadence is decided in one place" checkable by reading
   * one call.
   */
  const maybeWrite = async (prefixCompleted: boolean, terminal: boolean): Promise<void> => {
    if (
      !shouldWriteTenantReport(
        { pagesSinceWrite, msSinceWrite: now() - lastWriteAtMs, movedSinceWrite },
        { prefixCompleted, terminal },
        {
          pageInterval: config.reportWritePages,
          timeIntervalMs: config.reportWriteMs,
          quarantineThreshold: config.quarantineWriteThreshold,
        }
      )
    ) {
      return;
    }
    await persist('in_progress', { prefixIndex, pageToken });
    // All three, after EVERY write. Dropping `movedSinceWrite` from this reset is
    // the edit that turns the threshold from a bound on the lag into a one-shot.
    pagesSinceWrite = 0;
    movedSinceWrite = 0;
    lastWriteAtMs = now();
  };

  /**
   * Flush one structured log line per accumulating metric, carrying THIS process's
   * delta — the only way the counters moved above become visible from a Cloud Run
   * job (see the Observability block).
   *
   * Called exactly once per `sweepTenant` invocation that reached the listing:
   * either from the catch, when the run ends mid-flight, or after the final report
   * write. The flag makes that "at most once" rather than "we remembered", because
   * a metric emitted twice is worse than one emitted late.
   */
  let metricDeltasLogged = false;
  const logTenantMetricDeltas = (): void => {
    if (metricDeltasLogged) return;
    metricDeltasLogged = true;
    logSweepMetric(
      metricNames.storageOrphanSweepObjectsScanned,
      metricLabels,
      counters.objectsScanned - inheritedCounters.objectsScanned
    );
    for (const reason of RETAIN_REASONS) {
      logSweepMetric(
        metricNames.storageOrphanSweepRetained,
        { ...metricLabels, reason },
        counters.retainedByReason[reason] - inheritedCounters.retainedByReason[reason]
      );
    }
    logSweepMetric(
      metricNames.storageOrphanSweepOrphans,
      metricLabels,
      counters.orphanCount - inheritedCounters.orphanCount
    );
    logSweepMetric(
      metricNames.storageOrphanSweepOrphanBytes,
      metricLabels,
      counters.orphanBytes - inheritedCounters.orphanBytes
    );
    logSweepMetric(
      metricNames.storageOrphanSweepQuarantined,
      metricLabels,
      counters.quarantinedCount - inheritedCounters.quarantinedCount
    );
    logSweepMetric(
      metricNames.storageOrphanSweepQuarantinedBytes,
      metricLabels,
      counters.quarantinedBytes - inheritedCounters.quarantinedBytes
    );
    logSweepMetric(
      metricNames.storageOrphanSweepQuarantineFailures,
      metricLabels,
      counters.quarantineFailures - inheritedCounters.quarantineFailures
    );
  };

  // ── The prefix / page loop ─────────────────────────────────────────────────
  try {
    prefixLoop: while (prefixIndex < prefixes.length) {
      for (;;) {
        const page = await listObjectPage(bucket, prefixes[prefixIndex], pageToken, config.pageSize);

        for (const object of page.objects) {
          const facts: ObjectFacts = {
            objectPath: object.name,
            lastTouchedMs: resolveLastTouchedMs(object.metadata),
            bytes: parseObjectBytes(object.metadata),
          };

          const disposition = resolveObjectDisposition(facts, decisionContext);
          counters.objectsScanned += 1;
          // Counter only, at exactly the point the report counter moves. A map
          // write and a short key string, against a listing round-trip that
          // dominates it by orders of magnitude; the log line for this metric is
          // emitted once per tenant, below.
          countSweepMetric(metricNames.storageOrphanSweepObjectsScanned, metricLabels);

          if (disposition.action === 'retain') {
            counters.retainedByReason[disposition.reason] += 1;
            countSweepMetric(metricNames.storageOrphanSweepRetained, {
              ...metricLabels,
              reason: disposition.reason,
            });
            if (disposition.reason === 'referenced' && !derivedPaths.has(facts.objectPath)) {
              counters.fieldReferencesObserved += 1;
            }
            continue;
          }

          counters.orphanCount += 1;
          counters.orphanBytes += facts.bytes ?? 0;
          countSweepMetric(metricNames.storageOrphanSweepOrphans, metricLabels);
          // `bytes` is `null` for an object whose metadata did not parse; `incBy`
          // ignores a non-positive delta, so an unknown size contributes nothing
          // rather than a zero-valued series.
          countSweepMetric(metricNames.storageOrphanSweepOrphanBytes, metricLabels, facts.bytes ?? 0);
          if (counters.sampleOrphanPaths.length < MAX_SAMPLE_ORPHAN_PATHS) {
            counters.sampleOrphanPaths.push(facts.objectPath);
          }

          if (!config.applyMode) continue;

          // At most once per object path within one Sweep_Id (Req 13.11). Only a
          // resume that re-lists a page it already handled can offer the same path
          // twice, and a re-offer is skipped rather than counted as a failure — the
          // move already succeeded. Checked BEFORE the ceiling so a re-offer cannot
          // consume ceiling budget it has already spent.
          if (quarantinedInThisRun.has(facts.objectPath)) continue;

          // Apply mode. The ceiling is checked BEFORE the move, so
          // `quarantinedCount` can never exceed it (Req 11.17), and the cursor is
          // persisted at the CURRENT page so the remainder is a deliberate second
          // run rather than an accident (Req 11.18).
          if (counters.quarantinedCount >= config.maxQuarantinePerTenant) {
            abortReason = 'quarantine_cap_reached';
            await persist('aborted', { prefixIndex, pageToken }, { abortReason });
            // The abort counter moves at the single post-loop site, so this and the
            // scope violation below are counted exactly once each.
            break prefixLoop;
          }

          const mover = args.quarantineObject;
          if (!mover) {
            // Unreachable: `runStorageOrphanSweep` refuses apply mode without a
            // mover. Counted rather than silently skipped so the per-page
            // invariant below stays honest if it ever is reached.
            counters.quarantineFailures += 1;
            countSweepMetric(metricNames.storageOrphanSweepQuarantineFailures, metricLabels);
            continue;
          }

          let moved: { ok: true; bytes: number | null } | { ok: false; message: string };
          try {
            moved = await mover({
              bucket,
              db,
              tenantId,
              sweepId: config.sweepId,
              objectPath: facts.objectPath,
              bytes: facts.bytes,
              quarantineRetentionDays: config.quarantineRetentionDays,
              nowMs: config.nowMs,
            });
          } catch (error) {
            // A scope violation at a mutation point is non-retryable and ends the
            // tenant's run (Req 4.9, 4.10): it means the guard's own precondition
            // was wrong, and no retry wrapper may turn that into an eventual
            // write. Everything else propagates — see the catch below.
            if (error instanceof TenantScopeViolation) {
              abortReason = 'tenant_scope_violation';
              await persist('aborted', { prefixIndex, pageToken }, { abortReason });
              console.warn('[orphan_sweep] tenant scope violation at the quarantine guard', {
                tenantId,
                reason: error.reason,
              });
              break prefixLoop;
            }
            throw error;
          }

          if (moved.ok) {
            quarantinedInThisRun.add(facts.objectPath);
            counters.quarantinedCount += 1;
            const movedBytes = moved.bytes ?? facts.bytes ?? 0;
            counters.quarantinedBytes += movedBytes;
            countSweepMetric(metricNames.storageOrphanSweepQuarantined, metricLabels);
            countSweepMetric(metricNames.storageOrphanSweepQuarantinedBytes, metricLabels, movedBytes);

            // ── The threshold is evaluated AFTER EACH MOVE, not only at a page
            //    boundary, and this is the one place an implementer gets it wrong ──
            //
            // A boundary-only check leaves Defect 1's ceiling breach **fully open**
            // in the worst case: `config.pageSize` defaults to **1000 objects**, so a
            // listing whose orphans cluster on one page can move up to the **entire
            // ceiling** within a single page and crash before the boundary check ever
            // runs — persisted count `0`, resume moves a further ceiling, total
            // `2 x ceiling`. That is the identical breach the exception exists to
            // close, so Req 7.3's "lags by fewer than the Quarantine_Write_Threshold"
            // and Req 7.22's "at most that threshold" are only satisfiable by a
            // PER-MOVE evaluation.
            //
            // `pageToken` is unadvanced here, so this write cannot move the cursor
            // forward — see `maybeWrite` for why leading counters are the safe
            // asymmetry.
            movedSinceWrite += 1;
            await maybeWrite(false, false);
          } else {
            counters.quarantineFailures += 1;
            countSweepMetric(metricNames.storageOrphanSweepQuarantineFailures, metricLabels);
          }
        }

        // The page's work is complete; ONLY NOW does the cursor advance. Persisting
        // after the mutation rather than before is the `offlineDevicePrune`
        // ordering: a mid-run failure leaves the last SUCCESSFUL cursor intact, and
        // the worst case is re-examining one page (Req 13.5). The cursor and the
        // counters still travel in the SAME write (Req 7.24) — that is what makes
        // batching remove write points without desynchronising the two, so an
        // interruption can cause a page to be re-examined and can never cause an
        // object to be skipped.
        pageToken = page.nextPageToken;
        pagesSinceWrite += 1;
        // Req 7.4 — a finished Managed_Category prefix forces a write.
        const prefixCompleted = pageToken === null;

        // Every candidate is moved, failed, or blocked by the ceiling — never
        // silently dropped (Req 13.16) — and the retain set has not moved
        // underneath the listing (Property 14).
        //
        // ── MOVED ABOVE THE CONDITIONAL WRITE, and run on EVERY page (Req 7.10) ──
        //
        // It is a programming-error detector for a dropped object; gating it on the
        // write interval would make it fire on one page in ten. The reorder has one
        // behaviour consequence worth recording: the shipped code wrote first, so a
        // violation left the *advanced* cursor persisted; now it leaves the
        // *previous* cursor, which is strictly more conservative — the page whose
        // accounting failed is re-examined rather than skipped.
        //
        // **Its cadence stays per PAGE and the threshold does not touch it.** A
        // threshold write can land BETWEEN two invariant checks; that costs nothing,
        // because a violation detected at the following boundary still leaves an
        // unadvanced cursor persisted. Do NOT add an invariant evaluation to the
        // per-move path to "match" the write.
        assertInvariants(
          tenantId,
          counters,
          retainPaths.size,
          retainPathsSizeAtStart,
          inheritedCounters
        );

        await maybeWrite(prefixCompleted, false);

        if (pageToken === null) break;
      }
      prefixIndex += 1;
      pageToken = null;
    }
  } catch (error) {
    // The previous page's cursor and counters stay exactly as they were: this
    // write touches `lastError` and nothing else (Req 13.13, 13.14). The error
    // then propagates — now into `runStorageOrphanSweep`'s per-tenant confinement
    // rather than into `main().catch`, so every later tenant is still swept while
    // the runner still exits non-zero (Req 1.1, 2.1, parent Req 13.15).
    const message = describeThrownValue(error);
    try {
      await reportRef.set(
        stripUndefinedDeep({
          // ── The ONE place a Report_Document comes to record `'failed'` ──────
          //
          // One changed value (Req 1.7). Everything else about this write is
          // unchanged — still `status`, `lastError`, `runnerId`, `updatedAt` and
          // nothing else — which is what keeps the previous page's cursor and
          // counters standing exactly as the failing attempt left them (Req 1.6).
          //
          // `'in_progress'` would read as "a run is still going" for a tenant that
          // has stopped, and would be indistinguishable from a genuinely
          // mid-listing document. A reader that predates `'failed'` still parses
          // every other field and falls into its non-`'completed'` branch, so it
          // resumes this tenant from its cursor: correct behaviour, arrived at by
          // not recognising the value (Req 9.15).
          status: 'failed',
          lastError: message,
          runnerId: config.runnerId,
          updatedAt: new Date(),
        }),
        { merge: true }
      );
    } catch {
      // Best-effort diagnostics; never mask the original failure.
    }
    console.warn('[orphan_sweep] listing failed', { tenantId, mode: config.mode, message });
    // The tenant's run ended mid-flight rather than completing or aborting: the
    // resume cursor stands and a later run continues from it. Emitted before the
    // rethrow, which is the last moment this process can say anything — and the
    // partial counters are flushed with it, so the objects this attempt DID examine
    // are not lost to the crash.
    //
    // ── DO NOT "FIX" THE LABEL VALUE BELOW ───────────────────────────────────
    //
    // `outcome` stays `in_progress` even though the document just written and the
    // `TenantSweepResult` the confinement records both say `'failed'` (Req 1.15,
    // 10.12). The divergence is deliberate, because the two have different
    // consumers: the document is read by the resume path and by a human, both
    // inside this repository; this label is matched by a log-based metric filter
    // deployed in `infra/monitoring/`, which cannot be updated transactionally
    // with a deploy. Renaming it would change a deployed metric label value.
    //
    // This is also the `runs_total` line for this tenant for this invocation
    // (Req 1.9): the confinement site that catches this rethrow must NOT emit
    // another one, or every confined listing failure doubles the line.
    logTenantMetricDeltas();
    emitSweepMetric(
      metricNames.storageOrphanSweepRuns,
      { ...metricLabels, outcome: 'in_progress' },
      1
    );
    throw error;
  }

  // ── Phase 3: settle quota with ONE authoritative recompute ────────────────
  //
  // The recompute runs in BOTH modes; only the WRITE is apply-only.
  //
  // This was CORRECTED in `design.md` and **Requirements 14.3 and 14.4 are
  // authoritative**: `tenantStorageUsage/` is an application collection outside
  // `storageMaintenanceJobs/`, so writing it in report mode would make "report
  // mode mutates nothing" a guarantee with an exception — and a safety property
  // with an exception is not one an operator can rely on before an apply run.
  // Property 6 could not then be asserted as stated. Computing the number is not
  // writing it: the recompute is a `getFiles` plus a sum, i.e. a read. Do not
  // "restore" the report-mode write.
  //
  // Settled by recompute rather than by per-object decrement (Req 14.2) for three
  // concrete reasons: a decrement would UNDER-count for any object already in the
  // `originalDeleted` exclusion set; quarantine is copy-then-delete, so recorded
  // usage is transiently doubled mid-move; and the sweep has just listed every
  // managed prefix, so a full recompute is at its cheapest exactly here.
  //
  // The quarantine prefix is not among the summed prefixes, so quarantined bytes
  // contribute zero and leave the tenant's quota the moment they move, while a
  // failed quarantine delete leaves both copies and therefore OVER-counts until
  // the next recompute — never under-counts (Req 14.10).
  let usageBytesBefore: number | null = null;
  let usageBytesAfter: number | null = null;
  let usageError: string | null = null;
  try {
    usageBytesBefore = await readRecordedStorageBytes(db, tenantId);
  } catch (error) {
    usageError = describeThrownValue(error);
  }
  try {
    usageBytesAfter = await estimateTenantStorageBytes(bucket as never, tenantId, db);
    if (config.applyMode) {
      await db
        .collection('tenantStorageUsage')
        .doc(tenantId)
        .set(
          stripUndefinedDeep({ tenantId, bytes: usageBytesAfter, estimatedAt: new Date() }),
          { merge: true }
        );
      await args.invalidateLiveCount?.(`storageBytes:${tenantId}`);
    }
  } catch (error) {
    // The sweep succeeded and only the bookkeeping did not: record it, leave the
    // run `completed`, and continue with the next tenant (Req 14.11). Recorded
    // usage over-counts until the next reconcile, which is the safe direction.
    usageError = describeThrownValue(error);
  }

  // ── Dangling references ───────────────────────────────────────────────────
  //
  // A reference that resolved to a well-formed in-bucket path absent from the
  // listing. Counted, reported, and NEVER repaired — mutating an application
  // record is a far larger blast radius than moving an object (Req 15.1, 15.2).
  //
  // Computed as a difference rather than by remembering which paths were seen: an
  // object name appears at most once per listing, so `retainedByReason.referenced`
  // already IS the number of retain paths present in the bucket, and no second
  // set of the same order of magnitude as `retainPaths` is needed. Derived paths
  // are excluded from both sides — see `TenantReferenceSet.derivedPaths`. Clamped
  // at zero because a resumed run may re-examine one page and count a reference
  // twice.
  const fieldReferenceTotal = Math.max(0, retainPaths.size - derivedPaths.size);
  const danglingReferenceCount =
    abortReason === null
      ? Math.max(0, fieldReferenceTotal - counters.fieldReferencesObserved)
      : 0;

  const status: 'completed' | 'aborted' = abortReason === null ? 'completed' : 'aborted';

  // Req 7.5's terminal write, unchanged apart from carrying the write count. It does
  // NOT route through `maybeWrite`: a terminal outcome is one of the three
  // enumerated exceptions, so the scheduler would return `true` unconditionally and
  // asking it would only add a way for this write to be skipped.
  reportWrites += 1;
  await writeTenantReport({
    reportRef,
    references,
    config,
    status,
    abortReason,
    resume: abortReason === 'quarantine_cap_reached' ? { prefixIndex, pageToken } : null,
    counters,
    danglingReferenceCount,
    usageBytesBefore,
    usageBytesAfter,
    startedAt,
    completed: true,
    lastError: usageError,
    reportWrites,
  });

  // Counts and reasons only: no object path, no filename, no email address, no
  // download token, no share token (Req 16.9, 16.10).
  console.log('[orphan_sweep] tenant swept', {
    tenantId,
    mode: config.mode,
    applied: config.applyMode,
    status,
    abortReason,
    objectsScanned: counters.objectsScanned,
    retainedByReason: counters.retainedByReason,
    orphanCount: counters.orphanCount,
    orphanBytes: counters.orphanBytes,
    quarantinedCount: counters.quarantinedCount,
    quarantineFailures: counters.quarantineFailures,
    danglingReferenceCount,
    usageBytesBefore,
    usageBytesAfter,
    usageError,
  });

  // ── The metric surface for this tenant ────────────────────────────────────
  //
  // The accumulating deltas first, then the one-shot signals. The abort counter
  // moves here for the two Phase 2 aborts (`quarantine_cap_reached`,
  // `tenant_scope_violation`) — the pre-listing gate has its own site above — so
  // exactly one abort is counted per tenant run.
  logTenantMetricDeltas();
  if (abortReason !== null) {
    emitSweepMetric(
      metricNames.storageOrphanSweepAborted,
      { ...metricLabels, abort_reason: abortReason },
      1,
      'WARNING'
    );
  }
  // A per-RUN figure rather than a delta: it is computed from the difference
  // between the reference set and what the listing observed, so a resumed run
  // reports its own view. Rising is the evidence that would justify the
  // reference-repair follow-up spec; it is not alerted on.
  emitSweepMetric(
    metricNames.storageOrphanSweepDanglingReferences,
    metricLabels,
    danglingReferenceCount
  );
  // Req 10.6 — the number that says batching is in force, at INFO and not alerted
  // on: a count near the tenant's page count means the cadence collapsed. A per-RUN
  // figure like the dangling total, not a delta, and emitted through the same
  // one-shot pair, so the counter and the line move exactly once together.
  emitSweepMetric(metricNames.storageOrphanSweepReportWrites, metricLabels, reportWrites);
  emitSweepMetric(metricNames.storageOrphanSweepRuns, { ...metricLabels, outcome: status }, 1);

  return {
    tenantId,
    status,
    ...(abortReason ? { abortReason } : {}),
    mode: config.mode,
    applied: config.applyMode,
    sweepId: config.sweepId,
    ...counters,
    danglingReferenceCount,
    usageBytesBefore,
    usageBytesAfter,
    ...(usageError ? { usageError } : {}),
    reportWrites,
  };
}

/**
 * One page of one prefix, never the whole listing.
 *
 * `autoPaginate: false` is not decoration: with the library default the client
 * follows every page token itself and returns the entire prefix in one array,
 * which would materialise the listing, defeat `pageSize`, and leave this loop
 * with no cursor to persist. `sumStoragePrefixBytes` sets the same flag for the
 * same reason — see the note there, which records that it did NOT until the
 * review pass and that its own `do/while` was therefore running exactly once over
 * an already-fully-materialised listing. The next token is read from both places
 * the client can put it.
 */
async function listObjectPage(
  bucket: SweepBucket,
  prefix: string,
  pageToken: string | null,
  pageSize: number
): Promise<{ objects: { name: string; metadata: unknown }[]; nextPageToken: string | null }> {
  const response = await bucket.getFiles({
    prefix,
    maxResults: pageSize,
    autoPaginate: false,
    ...(pageToken ? { pageToken } : {}),
  });

  const files = Array.isArray(response[0]) ? (response[0] as unknown[]) : [];
  const objects: { name: string; metadata: unknown }[] = [];
  for (const file of files) {
    const name = readField(file, 'name');
    if (typeof name === 'string' && name.length > 0) {
      objects.push({ name, metadata: readField(file, 'metadata') });
    }
  }

  const fromQuery = readField(response[1], 'pageToken');
  const fromApiResponse = readField(response[2], 'nextPageToken');
  const nextPageToken =
    typeof fromApiResponse === 'string' && fromApiResponse
      ? fromApiResponse
      : typeof fromQuery === 'string' && fromQuery
        ? fromQuery
        : null;

  return { objects, nextPageToken };
}

/**
 * The three invariants worth failing loudly on, checked once per page rather than
 * merely documented.
 *
 * All three are programming-error detectors: reaching any of them means an object
 * was dropped, a candidate was dropped, or the retain set moved during the
 * listing, and each would silently change which objects a run judges.
 *
 * ── Why the accounting identity is here and not only in the comments ──────────
 *
 * `quarantined + failures <= orphans` bounds only the MUTATION side of the ledger.
 * It says nothing about an object that was scanned and then fell through every
 * branch without being counted anywhere — which is the shape a future edit to the
 * per-object `if/continue` chain would take, and which is invisible in every
 * downstream number because `objectsScanned` and the reason counters would simply
 * disagree by one. So the exact identity
 *
 *     objectsScanned == sum(retainedByReason) + orphanCount
 *
 * is asserted too. It is asserted on the DELTA against the counters this process
 * inherited from an interrupted earlier attempt, not on the absolute totals: the
 * baseline is read back out of a Firestore document, and a document written by a
 * different version of this code (a sixth retain reason, say) must not be able to
 * turn a resume into a crash. The delta is what this process is responsible for,
 * and it is exactly where a fall-through would show up.
 */
export function assertSweepInvariants(
  tenantId: string,
  counters: SweepCounters,
  retainPathsSize: number,
  retainPathsSizeAtStart: number,
  inherited: SweepCounters
): void {
  if (counters.quarantinedCount + counters.quarantineFailures > counters.orphanCount) {
    throw new Error(
      `[orphan_sweep] invariant violated for tenant ${tenantId}: quarantined + failures exceeds candidates`
    );
  }
  if (retainPathsSize !== retainPathsSizeAtStart) {
    throw new Error(
      `[orphan_sweep] invariant violated for tenant ${tenantId}: the retain set changed during listing`
    );
  }
  const scanned = counters.objectsScanned - inherited.objectsScanned;
  const retained = RETAIN_REASONS.reduce(
    (sum, reason) => sum + (counters.retainedByReason[reason] - inherited.retainedByReason[reason]),
    0
  );
  const orphans = counters.orphanCount - inherited.orphanCount;
  if (scanned !== retained + orphans) {
    throw new Error(
      `[orphan_sweep] invariant violated for tenant ${tenantId}: ${scanned} objects scanned but ${retained} retained + ${orphans} candidates accounted for`
    );
  }
}

/** `tenantStorageUsage/{tenantId}.bytes`, or `null` when absent. A READ. */
async function readRecordedStorageBytes(db: Firestore, tenantId: string): Promise<number | null> {
  const snapshot = await db.collection('tenantStorageUsage').doc(tenantId).get();
  if (!snapshot.exists) return null;
  let data: unknown;
  try {
    data = snapshot.data();
  } catch {
    return null;
  }
  return toNullableNumber(readField(data, 'bytes'));
}

/**
 * The Report_Document — **identical in shape in both modes** (Req 10.7), so a
 * report is a true dry-run description of what an apply run would do.
 *
 * Everything about the run is recorded, including every parameter, so a lowered
 * Grace_Period is visible and a report stays interpretable months later
 * (Req 16.2). Nothing customer-identifying is: no email, no download token, no
 * share token. `sampleOrphanPaths` and `crossTenantReferences` are bounded, and
 * `partial` is set whenever a source failed, so a truncated orphan count is never
 * read as authoritative (Req 9.10).
 */
async function writeTenantReport(args: {
  reportRef: ReturnType<Firestore['doc']>;
  references: TenantReferenceSet;
  config: ResolvedSweepConfig;
  /**
   * Widened to match `TenantSweepResult.status` (Req 9.14). No caller passes
   * `'failed'` today: the one Report_Document that comes to record it is written
   * by `sweepTenant`'s own catch, which sets `status`, `lastError`, `runnerId` and
   * `updatedAt` with `{ merge: true }` and deliberately does not route through
   * here — that is what keeps the previous page's cursor and counters standing
   * (Req 1.6). The union is widened anyway so the two status fields cannot drift
   * apart.
   */
  status: 'in_progress' | 'completed' | 'aborted' | 'failed';
  abortReason: SweepAbortReason | null;
  /**
   * Which reference ceiling bound (Req 8.9), when one did. Passed explicitly only by
   * the pre-listing gate, which is the one site that can resolve the collector's
   * label against its own `size > maxReferences` comparison; every other call site
   * omits it and the collector's own value is recorded.
   */
  capBreach?: 'configured' | 'memory_guard' | null;
  resume: SweepResumeState | null;
  counters: SweepCounters;
  danglingReferenceCount: number | null;
  usageBytesBefore: number | null;
  usageBytesAfter: number | null;
  startedAt: Date;
  completed: boolean;
  lastError: string | null;
  /**
   * A mid-listing progress write advances the cursor and the counters and leaves
   * the settled-at-the-end fields (`danglingReferenceCount`, the usage numbers)
   * untouched, rather than writing a zero over a previous run's real value.
   */
  partialFieldsOnly?: boolean;
  /**
   * Report_Document writes issued for this tenant so far, INCLUDING this one
   * (Req 7.8). A progress field, so it is written on a mid-listing write too.
   */
  reportWrites: number;
}): Promise<void> {
  const { config, counters, references } = args;
  const now = new Date();

  const document: Record<string, unknown> = {
    tenantId: references.tenantId,
    status: args.status,
    mode: config.mode,
    applied: config.applyMode,
    sweepId: config.sweepId,
    runnerId: config.runnerId,
    // ── Which EXECUTION wrote this, not merely which runner (Req 5.19's diagnostic) ──
    //
    // `runnerId` names a deployment; `leaseToken` names one process's Run_Lease. It
    // is the field that would have made the shipped overlap diagnosable: a report
    // whose `leaseToken` differs from the token in a run's start-up log line is a
    // report written by ANOTHER execution — which, before the lease, was a state an
    // operator could only detect by listing `_orphan-quarantine/{tenantId}/` and
    // comparing Sweep_Id folders by eye.
    //
    // `null` when no lease was installed, which is every direct invocation of this
    // core. No requirement mandates this field and no task bullet asks for it; it is
    // specified in `design.md`'s "New Report_Document fields" table, so it is written
    // here rather than left for a later reader to conclude the write was forgotten.
    leaseToken: config.leaseToken ?? null,
    referenceFingerprint: references.referenceFingerprint,
    params: {
      graceDays: config.graceDays,
      graceCutoffMs: config.graceCutoffMs,
      quarantineRetentionDays: config.quarantineRetentionDays,
      pageSize: config.pageSize,
      maxQuarantinePerTenant: config.maxQuarantinePerTenant,
      maxReferences: config.maxReferences,
      // The RESOLVED value, not the configured one (Req 3.14): `parsePositiveIntEnv`
      // and `normalisePositiveInt` both fall back to the documented default rather
      // than to zero, so this is what was actually in force.
      firestorePageSize: config.firestorePageSize,
      // Req 7.13 — the write cadence actually in force, so an operator reading a
      // report can see it rather than infer it from `reportWrites`. All three are
      // RESOLVED values: `quarantineWriteThreshold` recorded as `0` would be the
      // visible symptom of a collapsed cadence, which is why the resolver floors it
      // at 1 (Req 7.21) and why this field is worth having.
      reportWritePages: config.reportWritePages,
      reportWriteMs: config.reportWriteMs,
      quarantineWriteThreshold: config.quarantineWriteThreshold,
      // ── Req 8.13, the same three numbers the runner logs at start-up (Req 8.14) ──
      //
      // `maxReferences` above is the resolved ceiling; this is what that ceiling is
      // estimated to COST, so a report states what was compared rather than only that
      // something was. Derived from the ceiling — NOT from `references.retainPaths.size`
      // — deliberately: it is a run PARAMETER, it belongs beside `maxReferences`, and it
      // is the exact number the pre-flight refusal of Req 8.6 was decided against. The
      // per-tenant figure for the set actually collected travels separately, on
      // `TenantReferenceSet.footprintEstimateBytes`.
      footprintEstimateBytes: estimateRetainSetFootprintBytes(config.maxReferences),
      // The OBSERVED limit, `null` when nothing usable was observed. The runner's
      // start-up reading when it supplied one — that is the reading Req 8.6's refusal
      // compared — otherwise the collector's own last mid-collection reading, so a core
      // invoked directly still records what the guard compared rather than nothing.
      heapLimitBytes: config.heapLimitBytes ?? references.heapLimitBytes ?? null,
      // The Run_Lease duration in force, `null` when NO lease was installed — which
      // is the honest value for every direct invocation of this core and for the
      // whole parent suite (Req 5.16). Echoed from the runner rather than resolved
      // here; see `SweepConfig.leaseMs` for why this module must not import the
      // clamp.
      leaseMs: config.leaseMs ?? null,
      nowMs: config.nowMs,
      force: config.force === true,
    },
    countsBySource: references.countsBySource,
    // Additive. Non-zero for every source that has data is the cheapest signal that
    // no walk stopped after one page; `?? {}` for the same reason
    // `transcodeOnlyReferences` carries one — a caller holding an older
    // `TenantReferenceSet` shape writes an empty map rather than an `undefined`.
    pagesBySource: references.pagesBySource ?? {},
    referenceCount: references.retainPaths.size,
    derivedReferenceCount: references.derivedPaths ? references.derivedPaths.size : 0,
    resume: args.resume,
    objectsScanned: counters.objectsScanned,
    retainedByReason: counters.retainedByReason,
    orphanCount: counters.orphanCount,
    orphanBytes: counters.orphanBytes,
    quarantinedCount: counters.quarantinedCount,
    quarantinedBytes: counters.quarantinedBytes,
    quarantineFailures: counters.quarantineFailures,
    fieldReferencesObserved: counters.fieldReferencesObserved,
    sampleOrphanPaths: counters.sampleOrphanPaths.slice(0, MAX_SAMPLE_ORPHAN_PATHS),
    crossTenantReferences: references.crossTenantReferences,
    crossTenantReferenceCount: references.crossTenantReferenceCount,
    transcodeOnlyReferences: references.transcodeOnlyReferences ?? [],
    transcodeOnlyReferenceCount: references.transcodeOnlyReferenceCount ?? 0,
    malformedReferences: references.malformedReferences,
    failedSources: references.failedSources,
    // Non-empty `failedSources` means the orphan count is not authoritative.
    partial: references.failedSources.length > 0,
    abortReason: args.abortReason,
    // Additive (Req 8.9, 9.6), and `null` rather than absent for every run that
    // breached no ceiling: a reader distinguishing "no breach" from "a field this
    // writer did not know about" is exactly what an additive field owes it.
    // Meaningful only alongside `abortReason === 'reference_cap_exceeded'`.
    //
    // An EXPLICIT `null` from the caller wins over the collector's own label, which
    // is why this is an `undefined` test rather than `??`. The case is real: a tenant
    // whose ceiling breached AND whose source failed aborts as
    // `reference_source_failed` by the documented precedence, and recording a
    // `capBreach` beside that abort reason would name a limit that is not the reason
    // this tenant stopped. Only the pre-listing gate, which resolved that precedence,
    // passes the field; every other write omits it and gets the collector's value.
    capBreach: args.capBreach === undefined ? (references.capBreach ?? null) : args.capBreach,
    // Additive (Req 9.6). Manual verification step 7 reads it off the report: a
    // count far below the tenant's page count is the evidence batching is in force.
    reportWrites: args.reportWrites,
    startedAt: args.startedAt,
    updatedAt: now,
    completedAt: args.status === 'in_progress' ? null : now,
    lastError: args.lastError,
  };

  if (args.partialFieldsOnly !== true) {
    document.danglingReferenceCount = args.danglingReferenceCount ?? 0;
    document.usageBytesBefore = args.usageBytesBefore;
    document.usageBytesAfter = args.usageBytesAfter;
  }

  await args.reportRef.set(stripUndefinedDeep(document), { merge: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// Stage 2 — the quarantine move, and its exact inverse
// ═════════════════════════════════════════════════════════════════════════════
//
// This is the first code in the whole plan that can move an object, and it lands
// only after report mode has been proven to mutate nothing (Property 6). Stage 3,
// the hard delete, is a separate function with a disjoint input domain.
//
// ── The ordering IS the safety property ─────────────────────────────────────
//
//   1. copy    — a failed copy leaves the original untouched (Req 11.6);
//   2. verify  — a failed or size-mismatched verify aborts BEFORE the delete
//                (Req 11.4, 11.7): a copy that does not match the source is not a
//                copy;
//   3. manifest— recorded before the delete (Req 11.5);
//   4. delete  — a failed delete leaves BOTH copies (Req 11.8), an over-count the
//                next `estimateTenantStorageBytes` corrects.
//
// So at every point of a move the bytes are retrievable from the original path,
// the quarantine path, or both; there is no interleaving in which both are absent
// (Req 11.10). Any failure increments `quarantineFailures` and the sweep continues
// with the next candidate (Req 11.9) — the original is still there and the next
// run will offer it again, under a new Sweep_Id.
//
// ── What the manifest is, and is not ────────────────────────────────────────
//
// It is a convenience for `restoreFromQuarantine` and for the report. It is NOT
// the safety mechanism: the bytes are, and `parseQuarantinePath` reconstructs the
// original path from the quarantine path alone (Req 12.10), so a lost manifest
// costs an operator nothing but a listing.

/** One manifest document per moved object, under the tenant's report document. */
export interface QuarantineManifestEntry {
  objectPath: string;
  quarantinePath: string;
  bytes: number | null;
  movedAt: Date;
  retainedUntil: Date;
  sweepId: string;
  tenantId: string;
}

/**
 * `storageMaintenanceJobs/orphanSweep/tenants/{t}/quarantine/{sweepId}_{hash}`.
 *
 * The id is a deterministic function of `(sweepId, objectPath)`, which is what
 * makes a repeated move within one Sweep_Id idempotent at the manifest as well as
 * in the bucket (Req 13.11): the same document is rewritten rather than a second
 * one appearing. The object path is HASHED rather than embedded — it may contain
 * `/`, which a document id may not, and a client-supplied filename has no business
 * in a document id (Req 16.9).
 */
export function quarantineManifestPath(
  tenantId: string,
  sweepId: string,
  objectPath: string
): string {
  const digest = crypto.createHash('sha256').update(objectPath, 'utf8').digest('hex').slice(0, 32);
  return `${tenantReportPath(tenantId)}/quarantine/${sweepId}_${digest}`;
}

/**
 * The `[payload, apiResponse]` tuple the storage client resolves, or the payload
 * itself. Both shapes are accepted because the payload is treated as untrusted
 * input either way.
 */
function unwrapClientPayload(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A `file()` handle, or a loud failure.
 *
 * A bucket with no `file()` cannot be a real bucket, and returning a quarantine
 * *failure* here would turn one misconfiguration into `quarantineFailures ===
 * orphanCount` and a `completed` run — so this throws, the listing loop records
 * `lastError`, and the runner exits non-zero.
 */
function requireObjectHandle(bucket: SweepBucket, objectPath: string): SweepObjectHandle {
  if (typeof bucket?.file !== 'function') {
    throw new TypeError(
      'quarantine: the bucket exposes no file() handle; refusing to report a move it cannot perform'
    );
  }
  return bucket.file(objectPath);
}

/**
 * Move one orphan into the quarantine namespace: **copy → verify → manifest →
 * delete**.
 *
 * Preconditions: `objectPath` was returned by this tenant's own Object_Listing and
 * `decideObjectDisposition` returned `action: 'report'` for it; `sweepId` is a
 * single plain path segment, minted once per run.
 *
 * Postconditions:
 *  - the object's bytes are readable at `objectPath`, at the returned quarantine
 *    path, or at both, whatever happened (Req 11.10);
 *  - `ok: true` ⇒ a verified copy exists under
 *    `_orphan-quarantine/{tenantId}/{sweepId}/` and the original is gone;
 *  - `ok: false` ⇒ the original is still readable, and the caller increments
 *    `quarantineFailures` and continues (Req 11.9);
 *  - nothing is ever hard deleted here — that is `purgeExpiredQuarantine`'s job
 *    and its input domain is quarantine paths only (Req 11.2).
 *
 * Throws only for a programming error: a `TenantScopeViolation` (guard 2 of 3,
 * non-retryable, which ends the tenant's run with
 * `abortReason: 'tenant_scope_violation'` — Req 4.9, 4.10), a malformed `sweepId`,
 * or a bucket with no `file()`. None of the three is retryable and none should be
 * absorbed into a failure counter.
 */
export async function quarantineObject(args: {
  bucket: SweepBucket;
  db: Firestore;
  tenantId: string;
  sweepId: string;
  objectPath: string;
  bytes: number | null;
  quarantineRetentionDays?: number;
  nowMs?: number;
}): Promise<
  | { ok: true; bytes: number | null; quarantinePath: string }
  | { ok: false; message: string; stage: 'copy' | 'verify' | 'manifest' | 'delete' }
> {
  const { bucket, db, tenantId, sweepId, objectPath } = args;
  const expectedBytes = typeof args.bytes === 'number' && Number.isFinite(args.bytes) ? args.bytes : null;

  // Guard 2 of 3. Unreachable from the listing loop in practice — the
  // Decision_Function evaluates scope FIRST, so an out-of-scope path is retained
  // as `unmanaged_path` and never becomes a candidate — which is exactly why it
  // belongs here: it is the assertion that the unreachable stays unreachable.
  assertTenantScoped(objectPath, tenantId);

  // Built SOLELY from the already-asserted path (Req 17.13). The caller never
  // assembles a destination by hand, and the `sweepId` folder is what makes two
  // runs quarantining the same path place each copy under a distinct folder
  // (Req 11.20).
  const quarantinePath = buildQuarantinePath({ tenantId, sweepId, objectPath });
  const expectedPrefix = `${QUARANTINE_PREFIX}/${tenantId}/`;
  if (!quarantinePath.startsWith(expectedPrefix)) {
    throw new Error('quarantineObject: built a destination outside the tenant quarantine namespace');
  }

  // Both handles are obtained BEFORE the first try block, so a bucket with no
  // `file()` fails loudly rather than being absorbed into `quarantineFailures`.
  const original = requireObjectHandle(bucket, objectPath);
  const destination = requireObjectHandle(bucket, quarantinePath);

  // ── 1. COPY ───────────────────────────────────────────────────────────────
  // A failure here leaves the original exactly as it was (Req 11.6).
  try {
    await original.copy(destination);
  } catch (error) {
    return { ok: false, stage: 'copy', message: describeThrownValue(error) };
  }

  // ── 2. VERIFY ─────────────────────────────────────────────────────────────
  // Before destroying anything: the copy must exist, and its byte size must match
  // the source's (Req 11.4). A failure or a mismatch returns WITHOUT deleting
  // (Req 11.7) — a copy that does not match the source is not a copy.
  //
  // ── The size comparison is TOTAL, and that is a correction ─────────────────
  //
  // `args.bytes` is the LISTING's size, and `parseObjectBytes` answers `null` for
  // anything it cannot read. This step used to skip the comparison entirely on that
  // `null`, verifying by existence alone — so a copy that landed at the right path
  // with the wrong bytes would have passed and the original would then have been
  // deleted. Reading a `null` size out of a real `bucket.getFiles()` page is not
  // reachable today (the JSON API always returns `size` for a finalized object), but
  // `bytes` arrives through the same untrusted-parse path as every other read value
  // and the cost of that branch being wrong is the permanent loss of an object's
  // bytes. So with no listing size, the SOURCE's own size is read here and the copy
  // is compared against that instead; a size that cannot be established on either
  // side is a verify failure, which keeps the original.
  //
  // The listing size is still PREFERRED where it exists, and not merely for the
  // saved round trip: it additionally catches an overwrite between the listing and
  // the copy. An object rewritten with different bytes after it was judged no longer
  // matches the size it was judged by, so the move is refused and the next run —
  // which will see the fresh `timeCreated` and retain it as `within_grace` — gets it
  // right. Reading the source's live size would compare the new bytes against
  // themselves and lose that.
  let copiedBytes: number | null = null;
  try {
    const metadata = unwrapClientPayload(await destination.getMetadata());
    if (metadata === null || typeof metadata !== 'object') {
      return {
        ok: false,
        stage: 'verify',
        message: 'quarantine copy returned no metadata; the copy is unverified',
      };
    }
    copiedBytes = parseObjectBytes(metadata);

    let referenceBytes = expectedBytes;
    if (referenceBytes === null) {
      referenceBytes = parseObjectBytes(unwrapClientPayload(await original.getMetadata()));
    }
    if (referenceBytes === null) {
      return {
        ok: false,
        stage: 'verify',
        message:
          'quarantine copy is unverifiable: no readable size on either the listing or the source object',
      };
    }
    if (copiedBytes !== referenceBytes) {
      return {
        ok: false,
        stage: 'verify',
        message: `quarantine copy size mismatch: expected ${referenceBytes}, found ${copiedBytes ?? 'unreadable'}`,
      };
    }
  } catch (error) {
    return { ok: false, stage: 'verify', message: describeThrownValue(error) };
  }

  // ── 3. MANIFEST, before the delete ───────────────────────────────────────
  // A convenience rather than the safety mechanism (Req 12.10) — but it is
  // recorded first regardless (Req 11.5), and a failure to record it skips the
  // delete. Both copies then remain: an over-count the next recompute corrects,
  // never a loss.
  const movedAtMs = typeof args.nowMs === 'number' && Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
  const retentionDays = normalisePositiveInt(
    args.quarantineRetentionDays,
    DEFAULT_QUARANTINE_RETENTION_DAYS
  );
  const entry: QuarantineManifestEntry = {
    tenantId,
    sweepId,
    objectPath,
    quarantinePath,
    bytes: expectedBytes ?? copiedBytes,
    movedAt: new Date(movedAtMs),
    retainedUntil: new Date(movedAtMs + retentionDays * DAY_MS),
  };
  try {
    await db.doc(quarantineManifestPath(tenantId, sweepId, objectPath)).set(
      stripUndefinedDeep(entry as unknown as Record<string, unknown>),
      { merge: true }
    );
  } catch (error) {
    return { ok: false, stage: 'manifest', message: describeThrownValue(error) };
  }

  // ── 4. DELETE the original ───────────────────────────────────────────────
  // `ignoreNotFound` because a concurrent delete of an object we have already
  // copied is the outcome we wanted, not an error. A genuine failure leaves BOTH
  // copies (Req 11.8).
  try {
    await original.delete({ ignoreNotFound: true });
  } catch (error) {
    return { ok: false, stage: 'delete', message: describeThrownValue(error) };
  }

  return { ok: true, bytes: expectedBytes ?? copiedBytes, quarantinePath };
}

/**
 * The exact inverse of a quarantine move. The recovery path, invoked by hand.
 *
 * `parseQuarantinePath` runs FIRST and is what confines this function: a path it
 * rejects is `not_a_quarantine_path` and nothing is touched (Req 11.14). The
 * reconstructed original path then passes the Scope_Guard before it is recreated.
 *
 * An occupied destination is refused (Req 11.13) rather than overwritten:
 * overwriting would destroy a newer object in order to recover an older one, and
 * a later upload that took the path is by definition the live one. With
 * `apply: false` the intended destination is reported and nothing changes.
 *
 * ── The download token survives, by design ──────────────────────────────────
 *
 * Restore does NOT re-mint the Firebase download token, and must not. Object
 * metadata — `firebaseStorageDownloadTokens` included — survives a GCS copy, so
 * the URL already stored on the owning record resolves again and the record needs
 * no repair. A restore that rotated the token would satisfy this spec while
 * breaking `upload-idempotency`'s Property 12, which depends on a returned URL
 * staying resolvable.
 *
 * The corollary is worth stating plainly: **quarantine is not an
 * access-revocation mechanism** (Req 17.16). Because the token is preserved, a
 * download URL that has already leaked keeps working on the quarantined copy for
 * the whole retention window, until the hard delete. Revoking access is a
 * different operation — rotate the token or delete the object outright — and
 * anyone reaching for this stage to accomplish it is reaching for the wrong tool.
 */
export async function restoreFromQuarantine(args: {
  bucket: SweepBucket;
  quarantinePath: string;
  apply: boolean;
}): Promise<{ restoredTo: string } | { error: 'not_a_quarantine_path' | 'destination_occupied' }> {
  const { bucket } = args;

  const parsed = parseQuarantinePath(args.quarantinePath);
  if (parsed === null) return { error: 'not_a_quarantine_path' };

  // The path we are about to RECREATE, guarded before anything is written.
  assertTenantScoped(parsed.objectPath, parsed.tenantId);

  const original = requireObjectHandle(bucket, parsed.objectPath);
  const quarantined = requireObjectHandle(bucket, args.quarantinePath);

  const occupied = unwrapClientPayload(await original.exists()) === true;
  if (occupied) return { error: 'destination_occupied' };

  if (args.apply !== true) return { restoredTo: parsed.objectPath };

  // Back to EXACTLY the original object path (Req 11.11), then the quarantine
  // copy goes. Copy before delete here too, for the same reason as the move.
  await quarantined.copy(original);
  await quarantined.delete({ ignoreNotFound: true });

  console.log('[orphan_sweep] restored from quarantine', {
    tenantId: parsed.tenantId,
    sweepId: parsed.sweepId,
  });

  return { restoredTo: parsed.objectPath };
}

// ═════════════════════════════════════════════════════════════════════════════
// Stage 3 — the hard delete, structurally confined to the quarantine namespace
// ═════════════════════════════════════════════════════════════════════════════
//
// This is the only irreversible code in the feature, and it is deliberately the
// last mutating code to land. Three separate things make it safe, and none of
// them is "we are careful here":
//
//  1. **A disjoint input domain (Property 8).** An object is deleted only where
//     `parseQuarantinePath` accepts its name. That function requires a first
//     segment of `_orphan-quarantine`, and `classifyTenantScopedPath` requires a
//     first segment in `STORAGE_TENANT_CATEGORIES`, of which `QUARANTINE_PREFIX`
//     is deliberately not a member. The two domains are therefore provably
//     disjoint, and **no live object path is in this function's delete domain** —
//     asserted over generated input in
//     `storageObjectRef.quarantineDomain.property.test.ts`. The guarantee is
//     structural: a bug anywhere in the reference enumeration can at worst
//     quarantine a referenced object, and cannot reach this stage at all.
//     Concretely: a live path that somehow appeared in this listing is counted as
//     `not_a_quarantine_path` and left alone, which is what the integration test
//     injects.
//  2. **An age gate.** Even inside the domain, an object is deleted only once it
//     is provably older than `retentionDays`, and an object whose age cannot be
//     determined is RETAINED — the same `age_unknown` posture
//     `decideObjectDisposition` takes, for the same reason: an age we cannot read
//     is not an age we can use to prove anything.
//  3. **`apply` defaults to false**, as does the purge switch itself. Nothing here
//     runs unless a caller explicitly turns it on twice
//     (`STORAGE_ORPHAN_SWEEP_PURGE_ENABLED` plus `apply`), and with `apply: false`
//     the stage is a counting dry-run.
//
// Redundant by design (Req 12.9): the load-bearing retention mechanism is the GCS
// lifecycle rule on `_orphan-quarantine/` (`infra/storage/quarantine-lifecycle.json`,
// task 3.5). This function depends on none of it — it exists so retention is not
// silently dependent on infrastructure this repository does not manage, and so an
// operator who wants to reclaim immediately can.
//
// It is a SEPARATE entry point and `runStorageOrphanSweep` never calls it. That is
// not tidiness: report mode's "no mutation of any kind" (Property 6) is only
// checkable if the irreversible stage is unreachable from the sweep, in either
// mode. The runner (task 10.1) calls this function under its own switch.
//
// The manifest is not consulted. The original path is reconstructed from the
// quarantine path ALONE (Req 12.10), so the manifest stays the convenience it was
// described as rather than quietly becoming the safety mechanism — a lost manifest
// costs an operator nothing here.

/**
 * Why the purger declined to delete an object it examined. Counted by reason on
 * the returned summary, the same way `sweepTenant` counts `retainedByReason`, so
 * "why is quarantine not draining?" is answerable from the numbers alone.
 */
export const PURGE_RETAIN_REASONS = [
  /** `parseQuarantinePath` rejected the name — including every live object path. */
  'not_a_quarantine_path',
  /** The reconstructed original path failed the Scope_Guard (Req 4.5). */
  'tenant_scope_violation',
  /** Neither `timeCreated` nor `updated` parsed: age unprovable ⇒ retain (Req 12.5). */
  'age_unknown',
  /** Provably inside the retention window. */
  'within_retention',
] as const;

export type PurgeRetainReason = (typeof PURGE_RETAIN_REASONS)[number];

/**
 * The purge summary, shaped for the Report_Document and the `storage_*_total`
 * counters alike: totals for what was examined and what was eligible, what was
 * actually deleted, why everything else was kept, and the bytes on each side.
 *
 * `deleteEligible` and `deleted` are separate on purpose. They are equal only in a
 * successful apply run; with `apply: false` the first is the dry-run answer and
 * the second is zero (Req 12.6), and a delete failure separates them again.
 */
export interface PurgeQuarantineResult {
  /** False ⇒ the switch was off and nothing was listed, let alone deleted. */
  enabled: boolean;
  /** True only where the switch was on AND `apply` was explicitly true. */
  applied: boolean;
  retentionDays: number;
  retentionCutoffMs: number;
  examined: number;
  deleteEligible: number;
  deleteEligibleBytes: number;
  deleted: number;
  deletedBytes: number;
  retained: number;
  retainedByReason: Record<PurgeRetainReason, number>;
  retainedBytes: number;
  /** Deletes that were attempted and threw. The object is still there. */
  failures: number;
  pagesListed: number;
}

/**
 * The subset of a resolved `SweepConfig` this stage reads, plus its own switch.
 *
 * Declared as its own shape so the runner can hand over the config it already
 * resolved (`ResolvedSweepConfig` satisfies it structurally) while a test can call
 * the function with no config at all. Every field is also accepted as a top-level
 * argument, and the top-level value WINS — the purge switch and the retention
 * period are the two knobs an operator sets independently of a sweep.
 */
export interface PurgeQuarantineConfigInput {
  /** `STORAGE_ORPHAN_SWEEP_PURGE_ENABLED`, read by the runner. Default FALSE. */
  purgeEnabled?: boolean;
  apply?: boolean;
  quarantineRetentionDays?: number;
  pageSize?: number;
  nowMs?: number;
  runnerId?: string;
}

export interface PurgeExpiredQuarantineArgs {
  bucket: SweepBucket;
  config?: PurgeQuarantineConfigInput;
  /** Overrides `config.purgeEnabled`. Default FALSE — the stage is off unless asked. */
  purgeEnabled?: boolean;
  /** Overrides `config.apply`. Default FALSE — count, delete nothing (Req 12.6). */
  apply?: boolean;
  /** Overrides `config.quarantineRetentionDays`. Defaults to 7 days (Req 12.11). */
  retentionDays?: number;
  nowMs?: number;
  pageSize?: number;
  /**
   * ACCEPTED AND DELIBERATELY UNREAD.
   *
   * `design.md`'s sketch carries a Firestore handle here and the runner has one to
   * pass, so it is accepted rather than made an error. It is never read, and that
   * is the point: the delete decision is a function of the object's own name and
   * its own metadata, so the manifest cannot become the safety mechanism by
   * accident (Req 12.10). Recording what was purged is the caller's business.
   */
  db?: Firestore;
}

function emptyPurgeRetainedByReason(): Record<PurgeRetainReason, number> {
  return PURGE_RETAIN_REASONS.reduce(
    (acc, reason) => {
      acc[reason] = 0;
      return acc;
    },
    {} as Record<PurgeRetainReason, number>
  );
}

/**
 * Hard delete expired quarantine copies, and nothing else, ever.
 *
 * Lists the single `_orphan-quarantine/` prefix by page token and, for each
 * object: `parseQuarantinePath` must accept the name (**guard 3 of 3**), the
 * reconstructed original path must pass `assertTenantScoped` (Req 4.5), and the
 * object must be provably older than `retentionDays` — all three before anything
 * is deleted. See the section header above for why that composition is a
 * structural guarantee rather than a procedural one.
 *
 * Preconditions: none that a caller can violate destructively. `retentionDays`
 * that is non-finite or non-positive falls back to the documented 7 days rather
 * than to zero, exactly as the runner's numeric parsing does — a retention of `0`
 * would purge everything the moment it was quarantined and delete the entire
 * point of the stage.
 *
 * Postconditions:
 *  - an object is deleted only where `parseQuarantinePath(name) !== null` and its
 *    age exceeds `retentionDays` (Req 12.1, 12.4);
 *  - `purgeEnabled !== true` ⇒ nothing is listed and nothing is deleted (Req 12.7);
 *  - `apply !== true` ⇒ `deleted === 0` and no bucket mutator is invoked (Req 12.6);
 *  - an object whose age cannot be determined is retained (Req 12.5);
 *  - a delete that throws increments `failures` and the walk CONTINUES, because a
 *    single undeletable object must not strand every object behind it.
 *
 * Loop invariant: every object examined so far has been deleted, counted eligible
 * but not applied, counted as a failure, or retained under exactly one reason —
 * so `examined === deleted + failures + retained + (eligible not applied)`, with
 * no object silently dropped.
 */
export async function purgeExpiredQuarantine(
  args: PurgeExpiredQuarantineArgs
): Promise<PurgeQuarantineResult> {
  const { bucket } = args;
  const config = args.config ?? {};

  // Both switches default OFF and are read independently, so neither a missing
  // environment variable nor a mistyped one can delete anything.
  const enabled = (args.purgeEnabled ?? config.purgeEnabled) === true;
  const apply = (args.apply ?? config.apply) === true;

  const retentionDays = normalisePositiveInt(
    args.retentionDays ?? config.quarantineRetentionDays,
    DEFAULT_QUARANTINE_RETENTION_DAYS
  );
  const nowMs =
    typeof args.nowMs === 'number' && Number.isFinite(args.nowMs)
      ? args.nowMs
      : typeof config.nowMs === 'number' && Number.isFinite(config.nowMs)
        ? config.nowMs
        : Date.now();
  // ONE cutoff for the whole walk, injected once, for the same reason the sweep's
  // grace cutoff is: a long walk must not judge its last page by a later clock.
  const retentionCutoffMs = nowMs - retentionDays * DAY_MS;
  const pageSize = normalisePositiveInt(args.pageSize ?? config.pageSize, DEFAULT_PAGE_SIZE);

  const result: PurgeQuarantineResult = {
    enabled,
    applied: enabled && apply,
    retentionDays,
    retentionCutoffMs,
    examined: 0,
    deleteEligible: 0,
    deleteEligibleBytes: 0,
    deleted: 0,
    deletedBytes: 0,
    retained: 0,
    retainedByReason: emptyPurgeRetainedByReason(),
    retainedBytes: 0,
    failures: 0,
    pagesListed: 0,
  };

  if (!enabled) {
    // Logged rather than silent: "the purge did not run" and "the purge found
    // nothing to do" are different facts and an operator must be able to tell them
    // apart from the output alone.
    console.log('[orphan_sweep] quarantine purge disabled; nothing examined', {
      runnerId: config.runnerId,
    });
    return result;
  }

  // Refused up front, like `runStorageOrphanSweep`'s own two refusals: a bucket that
  // cannot name a file would otherwise turn one misconfiguration into
  // `failures === deleteEligible` and a summary that reads like a stage which ran.
  if (apply && typeof bucket?.file !== 'function') {
    throw new TypeError(
      'purgeExpiredQuarantine: apply mode requires a bucket with a file() handle; refusing to report a purge it cannot perform'
    );
  }

  const retain = (reason: PurgeRetainReason, bytes: number | null): void => {
    result.retained += 1;
    result.retainedByReason[reason] += 1;
    result.retainedBytes += bytes ?? 0;
  };

  let pageToken: string | null = null;
  for (;;) {
    const page = await listObjectPage(bucket, `${QUARANTINE_PREFIX}/`, pageToken, pageSize);
    result.pagesListed += 1;

    for (const object of page.objects) {
      result.examined += 1;
      const bytes = parseObjectBytes(object.metadata);

      // ── Guard 3 of 3, and the whole confinement argument ──────────────────
      // `null` for every string that is not
      // `_orphan-quarantine/{tenantId}/{sweepId}/{objectPath}` — which is every
      // live object path there is.
      const parsed = parseQuarantinePath(object.name);
      if (parsed === null) {
        retain('not_a_quarantine_path', bytes);
        continue;
      }

      // The Scope_Guard on the RECONSTRUCTED original path (Req 4.5). It catches
      // the two shapes a well-formed quarantine path can still carry: an original
      // path too shallow to be a managed object, and one naming a tenant other
      // than the folder it sits in. Neither is deletable here — refusing costs
      // bytes until the lifecycle rule collects them, and this stage has no
      // authority to resolve a contradiction it cannot explain.
      try {
        assertTenantScoped(parsed.objectPath, parsed.tenantId);
      } catch (error) {
        if (!(error instanceof TenantScopeViolation)) throw error;
        retain('tenant_scope_violation', bytes);
        console.warn('[orphan_sweep] purge refused a quarantine path outside its own tenant scope', {
          tenantId: parsed.tenantId,
          reason: error.reason,
        });
        continue;
      }

      // `max(timeCreated, updated)`, so a touched object reads as YOUNG and is
      // retained — the conservative direction here as in the sweep. For a
      // quarantined object `timeCreated` is the time of the COPY, which is exactly
      // what retention should count from, and matches the GCS lifecycle rule's own
      // `age` semantics.
      const lastTouchedMs = resolveLastTouchedMs(object.metadata);
      if (lastTouchedMs === null) {
        retain('age_unknown', bytes);
        continue;
      }
      // Written as a positive proof of "older than the cutoff", strictly, so an
      // object exactly at the cutoff is retained and a `NaN` cutoff retains
      // everything.
      if (!(lastTouchedMs < retentionCutoffMs)) {
        retain('within_retention', bytes);
        continue;
      }

      result.deleteEligible += 1;
      result.deleteEligibleBytes += bytes ?? 0;

      // The dry run stops here, having counted exactly what an apply run would
      // delete (Req 12.6). No `file()` handle is even obtained.
      if (!apply) continue;

      // Obtained OUTSIDE the try, so a bucket with no `file()` cannot be absorbed
      // into `failures` — the same reason `quarantineObject` acquires its handles
      // before its first try block.
      const handle = requireObjectHandle(bucket, object.name);
      try {
        // `ignoreNotFound` because the lifecycle rule may have collected it first;
        // this stage is redundant with that rule by design, so losing the race is
        // the outcome we wanted.
        await handle.delete({ ignoreNotFound: true });
        result.deleted += 1;
        result.deletedBytes += bytes ?? 0;
      } catch (error) {
        result.failures += 1;
        console.warn('[orphan_sweep] quarantine purge delete failed', {
          tenantId: parsed.tenantId,
          sweepId: parsed.sweepId,
          message: describeThrownValue(error),
        });
      }
    }

    pageToken = page.nextPageToken;
    if (pageToken === null) break;
  }

  // Counts and reasons only: no object path, no filename, no download token
  // (Req 16.8, 16.10).
  console.log('[orphan_sweep] quarantine purge finished', {
    applied: result.applied,
    retentionDays,
    retentionCutoffMs,
    pagesListed: result.pagesListed,
    examined: result.examined,
    deleteEligible: result.deleteEligible,
    deleted: result.deleted,
    deletedBytes: result.deletedBytes,
    retained: result.retained,
    retainedByReason: result.retainedByReason,
    failures: result.failures,
  });

  return result;
}

// ─── The run ─────────────────────────────────────────────────────────────────

export interface RunStorageOrphanSweepArgs {
  db: Firestore;
  rtdb: RealtimeDatabase;
  bucket: SweepBucket;
  config: SweepConfig;
  /**
   * `quarantineObject`. Required in apply mode, unused in report mode.
   *
   * Injected rather than called directly so that a caller which installs no mover
   * remains structurally incapable of moving an object — the same reason report
   * mode was proven inert before this code existed. The runner (task 10) passes
   * `quarantineObject` here.
   */
  quarantineObject?: QuarantineMover;
  invalidateLiveCount?: (cacheKey: string) => void | Promise<void>;
  /** Only tests set these, to exercise multi-page RTDB walks cheaply. */
  conversationPageSize?: number;
  messagePageSize?: number;
  /**
   * The heap READING forwarded to `collectTenantReferenceSet`, unexamined, for the
   * mid-collection guard. Defaults there to `readProcessHeapUsage`, so production
   * passes nothing and the default is the behaviour.
   *
   * It exists on this shape so a property test can put the guard's crossing at a
   * chosen admitted-reference count while driving the REAL run — which is the only
   * way to assert that a breach quarantines nothing and stops the paged reads. The
   * comparison it feeds is the pure `exceedsHeapGuard` either way.
   */
  readHeapUsage?: () => { usedBytes: number; limitBytes: number };
  /**
   * The LIVE clock, forwarded to `sweepTenant` for the report-write cadence and
   * for nothing else. See `SweepTenantArgs.now` for why it is not `config.nowMs`.
   */
  now?: () => number;
  /**
   * Forwarded to `sweepTenant`, unexamined. See `SweepTenantArgs.assertInvariants`
   * for why the seam exists and why production passes nothing.
   */
  assertInvariants?: typeof assertSweepInvariants;
  /**
   * Extend the Run_Lease and — the part that matters — **check that the recorded
   * Lease_Token is still ours**. Called as the FIRST statement of each tenant
   * iteration (Req 5.8). `{ ok: false }` means the lease is gone.
   *
   * ── OPTIONAL, and the optionality is Req 5.16 stated in the type system ──────
   *
   * This is the **only** coupling this core has to the Run_Lease: a zero-argument
   * callback, injected by the runner, exactly as `quarantineObject` and
   * `invalidateLiveCount` already are. With nothing installed the loop behaves
   * precisely as it did before the lease existed — which makes "every guarantee
   * `storage-orphan-cleanup` states holds independently of whether a Run_Lease was
   * acquired" **structurally** true rather than merely asserted, because "without a
   * lease" is literally the configuration the parent spec's entire suite runs in.
   *
   * Do NOT import `jobs/storageOrphanSweepLease.ts` here to "simplify" this into a
   * handle. The import direction is lease → core, and a core that imported the lease
   * back would break Req 5.16 at the module graph, where it is cheapest to check.
   *
   * ── Optional here, REQUIRED in the runner, and both are true at once ─────────
   *
   * "Advisory" describes what the lease *guarantees* — no correctness property
   * depends on it — not whether it may be skipped. Once the lease is wired into the
   * runner there is no path in which the runner sweeps a tenant without a granted
   * lease (Req 5.22). This parameter is optional so a *test* or a direct caller can
   * run leaseless, not so production can.
   */
  renewRunLease?: () => Promise<{ ok: boolean }>;
}

export interface StorageOrphanSweepRunResult {
  tenants: TenantSweepResult[];
  /** True whenever the run could not mutate: report mode, or `apply: false`. */
  dryRun: boolean;
  sweepId: string;
  /**
   * The number of Tenant_Sweep_Failures — tenants recorded `status: 'failed'`
   * (Req 1.11). The runner's exit-code input: `> 0` ⇒ a non-zero exit code, so
   * confining a failure cannot turn a red run green (Req 2.1).
   *
   * Counts Tenant_Sweep_Failures ONLY. No abort of any kind contributes, for any
   * of the five abort reasons: an abort is a designed safe outcome (Req 2.2).
   *
   * REQUIRED rather than optional, unlike the new `TenantSweepResult` fields: this
   * result is constructed fresh on every call and no persisted document has its
   * shape, so there is no older value to be backward compatible with.
   */
  tenantFailures: number;
  /**
   * Whether the run stopped because its Run_Lease was lost to a foreign
   * Lease_Token, or because the lease document was gone (Req 5.9). The run's other
   * exit-code input, alongside `tenantFailures`: `true` ⇒ a non-zero exit code.
   *
   * `false` for every run with no `renewRunLease` installed — the parent spec's
   * entire suite, and every direct invocation of this core (Req 5.16).
   *
   * A lost lease is deliberately NOT an abort. `SweepAbortReason` stays at exactly
   * its five values (Req 8.10): a sixth would be a new metric label value that no
   * deployed `infra/monitoring/` filter matches, i.e. an outcome nobody is alerted
   * on, for a condition that is about the RUN rather than about a tenant's data.
   * Tenants already swept keep their results and their Report_Documents.
   */
  leaseLost: boolean;
}

/**
 * Run the sweep over one or more tenants. Phase 1 then Phase 2, per tenant.
 *
 * Every enable gate lives in the runner (task 10); this core honours `mode` and
 * `apply` and is directly invocable by tests, exactly as
 * `runOfflineDevicePrune` / `runStorageOrphanSweep` split responsibilities.
 *
 * Two refusals happen up front, before anything is read or listed, because each
 * would otherwise look like a *successful* run that found a whole tenant
 * unreferenced:
 *
 *  - an empty `bucket.name`, which makes every stored reference resolve to
 *    `foreign_bucket` and therefore empties the retain set;
 *  - apply mode with no quarantine mover installed, which would report a
 *    `completed` destructive run that moved nothing.
 *
 * The Realtime Database handle is the third such misconfiguration and is refused
 * by `collectTenantReferenceSet` itself, and earlier still by the runner.
 */
export async function runStorageOrphanSweep(
  args: RunStorageOrphanSweepArgs
): Promise<StorageOrphanSweepRunResult> {
  const { db, rtdb, bucket } = args;
  const source = args.config;

  const nowMs =
    typeof source.nowMs === 'number' && Number.isFinite(source.nowMs) ? source.nowMs : Date.now();
  const graceDays =
    typeof source.graceDays === 'number' && Number.isFinite(source.graceDays) && source.graceDays > 0
      ? source.graceDays
      : DEFAULT_GRACE_DAYS;
  const applyMode = source.mode === 'sweep' && source.apply === true;

  const config: ResolvedSweepConfig = {
    ...source,
    graceDays,
    pageSize: normalisePositiveInt(source.pageSize, DEFAULT_PAGE_SIZE),
    maxQuarantinePerTenant: normalisePositiveInt(
      source.maxQuarantinePerTenant,
      DEFAULT_MAX_QUARANTINE_PER_TENANT
    ),
    maxReferences: normalisePositiveInt(source.maxReferences, DEFAULT_MAX_REFERENCES),
    firestorePageSize: normalisePositiveInt(
      source.firestorePageSize,
      DEFAULT_FIRESTORE_PAGE_SIZE
    ),
    // Req 7.12 — both fall back to their own documented default rather than to zero.
    reportWritePages: normalisePositiveInt(
      source.reportWritePages,
      DEFAULT_REPORT_WRITE_PAGE_INTERVAL
    ),
    reportWriteMs: normalisePositiveInt(
      source.reportWriteMs,
      DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS
    ),
    // ── The DEFAULT is Req 7.20; the floor at 1 is the separate Req 7.21 ───────
    //
    // Two obligations, and they are not interchangeable — which is the whole reason
    // this one field does not go through `normalisePositiveInt` like its neighbours.
    //
    // Req 7.20: a configured value that is non-finite, not greater than zero, or
    // TRUNCATES TO ZERO resolves to the documented default of 25.
    // `normalisePositiveInt` gets the third case wrong: `0.5` is finite and positive,
    // so it never reaches the fallback, and `Math.trunc(0.5)` is `0`. Paired with the
    // floor below that resolved to `1` — a write after EVERY move, where the manifests
    // and this report's own `params` document 25. `1` looks harmless next to `0`
    // precisely because it is not a write storm; it is still the wrong number, and an
    // operator who fat-fingered a decimal got it silently. So the resolution is
    // delegated to `resolveQuarantineWriteThreshold`, the pure module's own rule, and
    // `loadRunnerConfig` calls the same function — the two layers cannot disagree
    // about `0.5` the way they did.
    //
    // Req 7.21: the floor STAYS, and it is not belt-and-braces. It exists to make a
    // resolved `0` unreachable by ANY path, and a resolved `0` is the DANGEROUS
    // direction, not a suppressed write — the reason is the opposite of what it looks
    // like. Req 7.3's condition is `movedSinceWrite >= threshold`, it is checked FIRST
    // and UNCONDITIONALLY by `shouldWriteTenantReport`, and `movedSinceWrite` is never
    // negative. So `0` holds at EVERY evaluation and forces a Report_Document write on
    // every move, every page boundary and every terminal event alike: that is Defect
    // 2's write storm, arrived at through a configuration that merely looks unusual.
    // It is a backstop against a resolved zero, never a substitute for the fallback
    // above.
    quarantineWriteThreshold: Math.max(
      1,
      resolveQuarantineWriteThreshold(source.quarantineWriteThreshold)
    ),
    // Req 8.13 — a READING, not a knob, so it is echoed rather than normalised: an
    // unusable value becomes `null` ("nothing usable was observed") and never a
    // substituted default, because the whole operator value of this field is that it
    // reports what the process actually saw. A logged/recorded limit near 2 GB on a
    // `1Gi` container is how an operator learns `NODE_OPTIONS` did not reach the
    // process, and a default silently standing in for it would destroy that signal.
    heapLimitBytes:
      typeof source.heapLimitBytes === 'number' &&
      Number.isFinite(source.heapLimitBytes) &&
      source.heapLimitBytes > 0
        ? source.heapLimitBytes
        : null,
    // ── The lease's two echoed fields, resolved the same way and for the same
    //    reason: this core must not import the lease module (Req 5.16) ──────────
    //
    // `clampRunLeaseMs` is the rule that decides a lease duration and it lives in
    // `jobs/storageOrphanSweepLease.ts`. Calling it here would reverse the import
    // direction and make the core depend on the mechanism whose whole point is that
    // no guarantee depends on it. So the runner clamps once and this echoes: an
    // unusable value becomes `null`, meaning "no lease was installed", and never a
    // substituted default — a default standing in for an absent lease would make the
    // parent suite's own runs (which install none) look like leased ones.
    leaseMs:
      typeof source.leaseMs === 'number' && Number.isFinite(source.leaseMs) && source.leaseMs > 0
        ? source.leaseMs
        : null,
    leaseToken:
      typeof source.leaseToken === 'string' && source.leaseToken.length > 0
        ? source.leaseToken
        : null,
    quarantineRetentionDays: normalisePositiveInt(
      source.quarantineRetentionDays,
      DEFAULT_QUARANTINE_RETENTION_DAYS
    ),
    nowMs,
    sweepId: typeof source.sweepId === 'string' && source.sweepId ? source.sweepId : mintSweepId(nowMs),
    // ONE cutoff for the whole run, so a multi-hour sweep cannot have it drift
    // underneath and start judging objects it retained an hour earlier (Req 2.3).
    graceCutoffMs: computeGraceCutoffMs(nowMs, graceDays),
    applyMode,
  };

  const bucketName = typeof bucket?.name === 'string' ? bucket.name.trim() : '';
  if (!bucketName) {
    throw new TypeError(
      'runStorageOrphanSweep: a named bucket is required; an unnamed bucket resolves every reference as foreign and would report an entire tenant as orphaned'
    );
  }
  if (applyMode && !args.quarantineObject) {
    throw new TypeError(
      'runStorageOrphanSweep: apply mode requires a quarantine mover; refusing to report a destructive run that moved nothing'
    );
  }

  // Paged, and a failure on ANY page propagates from here — before the tenant loop
  // begins, so no tenant is swept (Req 4.7). See `resolveSweepTenantIds` for why
  // this one is not confined the way a per-tenant failure is.
  const tenantIds = await resolveSweepTenantIds(db, config.tenantIds, config.firestorePageSize);

  console.log('[orphan_sweep] run starting', {
    mode: config.mode,
    apply: applyMode,
    dryRun: !applyMode,
    graceDays: config.graceDays,
    graceCutoffMs: config.graceCutoffMs,
    pageSize: config.pageSize,
    maxQuarantinePerTenant: config.maxQuarantinePerTenant,
    maxReferences: config.maxReferences,
    firestorePageSize: config.firestorePageSize,
    sweepId: config.sweepId,
    runnerId: config.runnerId,
    tenants: tenantIds.length,
  });

  // ── "The job ran" must be visible even with nothing to run over ─────────────
  //
  // Every other metric here is emitted per tenant, so a run that resolves an EMPTY
  // tenant list would emit no `runs_total` line whatsoever — which contradicts the
  // Observability block's own stated reason for this metric: one line per
  // invocation, "emitted precisely so that 'the job ran' is visible on a run that
  // found nothing to do".
  //
  // The case that matters is not a fresh project. It is an `all_active` query that
  // silently stops matching — a `status` value drifting, say — which produces a
  // green run that did nothing, `aborted_total` holding at zero and looking healthy,
  // and no signal at all distinguishing it from a quiet, correct run. That is the
  // "a cleanup tool that silently stops running" failure the alert policy exists to
  // catch.
  //
  // No `tenant_id` label, because there is no tenant this line is about: the label
  // set is the same closed `SweepMetricLabels`, and `compactLabels` drops the absent
  // key rather than writing an empty one. The filter documented in
  // `infra/monitoring/README.md` selects on `jsonPayload.metric` alone, so the line
  // still matches.
  if (tenantIds.length === 0) {
    emitSweepMetric(
      metricNames.storageOrphanSweepRuns,
      { mode: config.mode, outcome: 'completed' },
      1
    );
  }

  const tenants: TenantSweepResult[] = [];
  // Set only by the fencing check below, and read only by the runner's exit code.
  // A lost lease is NOT an abort: `SweepAbortReason` stays at exactly its five
  // values (Req 8.10), and this is a `break` with a non-zero exit rather than a
  // sixth reason that would invalidate every deployed `infra/monitoring/` filter.
  let leaseLost = false;
  for (const tenantId of tenantIds) {
    // ── The Run_Lease fencing check, FIRST statement of the body (Req 5.8) ──────
    //
    // The top and not the bottom, and the difference is which fact the check
    // establishes: a renewal AFTER tenant *n* proves the lease was ours during *n*,
    // which is a fact about the past and changes nothing anyone can act on. A
    // renewal BEFORE tenant *n+1* is the fact that matters — it is the only moment
    // at which declining to start a tenant still prevents anything.
    //
    // Req 5.18: the lease is lost **at the instant of the reading**, not at the end
    // of the tenant in flight and not "probably lost, verify later". Because this
    // sits at the top of the body, the instant of the reading and the instant of the
    // decision to start this tenant are the SAME instant, so no tenant is ever
    // started under a lease that was already gone. That is why the check is here and
    // not, say, folded into the collector's arguments.
    //
    // Req 5.19: a fenced execution leaves the Run_Lease document **exactly as its
    // current holder recorded it**. This branch writes nothing to it — `renew`'s own
    // fencing branch writes nothing either — and the runner's `finally` release is a
    // token-matched no-op that finds a foreign token and deletes nothing. Releasing
    // on the way out would be strictly worse than doing nothing: it would strip the
    // new holder of the exclusivity it legitimately acquired and manufacture the
    // overlap the whole mechanism exists to prevent, at the one moment two
    // executions are demonstrably live.
    //
    // ── Renewal is a FENCE, not a liveness mechanism ────────────────────────────
    //
    // The lease duration (45 min) exceeds the job's `timeoutSeconds` (1800 s) by
    // design, so the platform kills the task before the lease can expire underneath
    // it and renewal never *needs* to extend anything. Saying so matters here rather
    // than only in the lease module: a reader who assumes renewal is for liveness
    // concludes that a MID-TENANT renewal is also needed, and a mid-tenant renewal
    // would put a Firestore transaction inside the object-listing page loop.
    //
    // Tenants already swept keep their results and their Report_Documents. Nothing
    // is rolled back, because nothing needs to be: everything moved so far was moved
    // under a lease this execution genuinely held.
    if (args.renewRunLease) {
      const renewal = await args.renewRunLease();
      if (!renewal.ok) {
        leaseLost = true;
        // No `tenant_id`: a lease is run-level, so there is no tenant this line is
        // about — and this one is emitted before `tenantId` is swept at all. At
        // WARNING, like the other two lease outcomes an operator must see.
        emitSweepMetric(
          metricNames.storageOrphanSweepLease,
          { mode: config.mode, outcome: 'lost' },
          1,
          'WARNING'
        );
        console.warn('[orphan_sweep] run lease lost; starting no further tenant', {
          mode: config.mode,
          sweepId: config.sweepId,
          tenantsSwept: tenants.length,
        });
        break;
      }
    }

    // ── TWO nested try/catch blocks, not one, and the reason is metric accounting
    //
    // Req 1.9 asks for exactly one `runs_total` line per tenant per invocation.
    // The two failure sites differ in whether that line has already been emitted
    // by the time the throw arrives here, so they cannot share one wrapper:
    //
    //  - `collectTenantReferenceSet` emits no `runs_total` at all, so the collector
    //    site must emit it (`emitRunsTotal: true`);
    //  - `sweepTenant`'s own catch already emitted `runs_total{outcome:'in_progress'}`
    //    and flushed its metric deltas before rethrowing, so the listing site must
    //    NOT (`emitRunsTotal: false`). One shared wrapper would double the line for
    //    every confined listing failure.
    //
    // Neither site writes a Report_Document. The listing site's report was already
    // written by `sweepTenant`'s catch, with its previous cursor and counters
    // intact; the collector site never reached a listing, so that tenant's report
    // keeps whatever the previous run recorded. The asymmetry is harmless: the next
    // run re-sweeps that tenant from its persisted cursor either way, because
    // `'failed'` and every other recorded non-`'completed'` status resume
    // identically (Req 1.13, 1.14).

    // Phase 1 runs on EVERY run: the retain set is never resumed across runs
    // (Req 13.4).
    let references: TenantReferenceSet;
    try {
      references = await collectTenantReferenceSet({
        db,
        rtdb,
        tenantId,
        bucketName,
        maxReferences: config.maxReferences,
        firestorePageSize: config.firestorePageSize,
        conversationPageSize: args.conversationPageSize,
        messagePageSize: args.messagePageSize,
        readHeapUsage: args.readHeapUsage,
      });
    } catch (error) {
      const failure = recordTenantFailure(tenantId, error, config, { emitRunsTotal: true });
      // ── Req 1.12 as a POSTCONDITION, asserted rather than inferred ──────────
      //
      // "A tenant whose Reference_Collector call raised quarantines zero objects,
      // including every object already identified as an Orphan candidate." It is
      // true structurally here — `sweepTenant` is never reached, so no mover is
      // ever offered a path — but Req 1.12 asks for it as a stated postcondition
      // rather than as a consequence of the order in which the collector and the
      // listing happen to be invoked. So it is checked at the confinement site,
      // where a future edit that made this failure result inherit partial counters
      // would trip it.
      assertNoQuarantineOnTenantFailure(failure);
      tenants.push(failure);
      continue;
    }

    // ── One `reference_pages_total` line per source that read a page (Req 10.7) ──
    //
    // Emitted HERE rather than inside `collectTenantReferenceSet` for one reason:
    // the collector deliberately emits no metric at all — the confinement above
    // depends on it (`emitRunsTotal: true` at the collector site exists precisely
    // because the collector emits nothing), and adding a `mode` argument to the
    // collector purely to label a metric would put an observability concern inside
    // the phase whose whole documented property is that it reads and returns.
    //
    // The Reference_Source identifier rides on `reason`, NOT on a new `source`
    // label. Req 10.1 permits exactly `tenant_id`, `mode`, `reason`, `outcome` and
    // `abort_reason`, and `SweepMetricLabels` is a closed type precisely so an
    // excess key cannot be expressed. Eight bounded values in `reason` is the
    // correct use of that slot; widening the closed set to carry a synonym is the
    // change Req 10.1 exists to prevent. Do not "fix" this by adding a label.
    //
    // `emitSweepMetric` because this is a one-shot per (tenant, source): no page is
    // counted per object anywhere, so the counter and the line move together
    // (Req 10.3). A source that read no page emits nothing, so an absent series
    // means "read no page" rather than "was not instrumented" (Req 10.9) — which is
    // what silently covers the RTDB walk and `tenant_branding`'s single `doc.get`.
    for (const sourceId of REFERENCE_SOURCE_IDS) {
      emitSweepMetric(
        metricNames.storageOrphanSweepReferencePages,
        { tenant_id: tenantId, mode: config.mode, reason: sourceId },
        references.pagesBySource ? references.pagesBySource[sourceId] : 0
      );
    }

    try {
      tenants.push(
        await sweepTenant({
          bucket,
          db,
          tenantId,
          references,
          config,
          quarantineObject: args.quarantineObject,
          invalidateLiveCount: args.invalidateLiveCount,
          now: args.now,
          assertInvariants: args.assertInvariants,
        })
      );
    } catch (error) {
      tenants.push(recordTenantFailure(tenantId, error, config, { emitRunsTotal: false }));
    }
  }

  return {
    tenants,
    dryRun: !applyMode,
    sweepId: config.sweepId,
    // Req 1.11. Read off the recorded status, so the count and the results cannot
    // disagree. `'failed'` only — no abort of any kind contributes (Req 2.2).
    tenantFailures: tenants.filter((tenant) => tenant.status === 'failed').length,
    // Req 5.9, the run's OTHER exit-code input. `false` for every run with no
    // `renewRunLease` installed, which is the parent suite's configuration and every
    // direct invocation of this core.
    leaseLost,
  };
}

/**
 * Record a Tenant_Sweep_Failure: the ONLY producer of `status: 'failed'`
 * (Req 1.1, 1.7).
 *
 * `describeThrownValue` coerces the thrown value, so a thrown `null`, a symbol, an
 * object whose `message` getter throws and a 10 kB string each yield a non-empty,
 * length-bounded message (Req 1.2, 1.3).
 *
 * The counters are EMPTY rather than partial. A listing failure's real, partial
 * counters live on the tenant's Report_Document, which `sweepTenant`'s catch has
 * already written and which the next run inherits; this result says "not swept",
 * and a half-count on it would be read as a total.
 *
 * `emitRunsTotal` is the whole reason the confinement is two nested blocks — see
 * the comment at the call sites. The `outcome` label is `in_progress`, matching the
 * value `sweepTenant`'s catch emits, and it does NOT follow the status to
 * `'failed'`: the value `'failed'` is confined to the two status fields and reaches
 * no metric label (Req 1.15, 10.12).
 */
function recordTenantFailure(
  tenantId: string,
  error: unknown,
  config: ResolvedSweepConfig,
  opts: { emitRunsTotal: boolean }
): TenantSweepResult {
  const failureMessage = describeThrownValue(error);
  const metricLabels: SweepMetricLabels = { tenant_id: tenantId, mode: config.mode };

  // Once per failure, from both sites (Req 10.4, 10.8). At WARNING: a tenant that
  // was not swept is the signal an operator is alerted on (Req 10.10).
  emitSweepMetric(metricNames.storageOrphanSweepTenantFailures, metricLabels, 1, 'WARNING');
  if (opts.emitRunsTotal) {
    emitSweepMetric(
      metricNames.storageOrphanSweepRuns,
      { ...metricLabels, outcome: 'in_progress' },
      1
    );
  }

  // The tenant id and the coerced message. No object path, no filename, no email
  // address, no download token is added by this line (Req 2.3, 16.8, 16.9, 16.10).
  console.warn('[orphan_sweep] tenant failed; confined to this tenant', {
    tenantId,
    mode: config.mode,
    message: failureMessage,
  });

  return {
    tenantId,
    status: 'failed',
    mode: config.mode,
    applied: config.applyMode,
    sweepId: config.sweepId,
    ...emptyCounters(),
    danglingReferenceCount: 0,
    usageBytesBefore: null,
    usageBytesAfter: null,
    failureMessage,
  };
}

/**
 * Req 1.12, as a postcondition on a Tenant_Sweep_Failure whose collector threw:
 * zero objects quarantined, zero bytes quarantined.
 *
 * Throws, like `assertSweepInvariants`, because a violation is a code defect rather
 * than a runtime condition: the only way to reach it is to change
 * `recordTenantFailure` so a failure result carries counters it did not earn.
 */
function assertNoQuarantineOnTenantFailure(result: TenantSweepResult): void {
  if (result.quarantinedCount !== 0 || result.quarantinedBytes !== 0) {
    throw new Error(
      `[orphan_sweep] INVARIANT: tenant ${result.tenantId} failed in reference collection yet reports ${result.quarantinedCount} quarantined objects (${result.quarantinedBytes} bytes); a tenant whose collector threw reaches no listing and must quarantine nothing`
    );
  }
}

/**
 * `sweep_{nowMs}_{random}` — a single plain path segment, as the quarantine builder
 * requires.
 *
 * ── EXPORTED for the runner (spec task 9.2), and the reason is an ORDERING ────
 *
 * The Run_Lease document records the run's Sweep_Id, so a Report_Document and the
 * lease that produced it can be tied together — which is the whole diagnostic value
 * of `RunLeaseDoc.sweepId`. But the lease must be acquired BEFORE the core is
 * entered (Req 5.1), so the id cannot be the one the core mints for itself: the
 * runner has to mint it, hand it to `acquireRunLease`, and pass the same value in
 * `SweepConfig.sweepId`.
 *
 * Exported rather than reimplemented in the runner because the format is a
 * CONSTRAINT, not a convention: it must be a single plain path segment, since
 * `buildQuarantinePath` interpolates it. A second minting rule in the runner is
 * exactly the "one rule stated in two places" drift this spec has already had to
 * repair once.
 */
export function mintSweepId(nowMs: number): string {
  return `sweep_${nowMs}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * The tenants to sweep: the configured allow-list, or the KEYSET-PAGINATED
 * active-tenant query — `tenants` where `status == 'active'`, the shape
 * `loadTenantRecords` uses in `jobs/tenantUsageRollup.ts`.
 *
 * The identifier is the DOCUMENT ID in both cases, never a value read out of a
 * record (Req 4.2, parent Req 4.11): every listing prefix and every Scope_Guard
 * check is built from it, so a tenant id sourced from a mutable field would be a
 * confinement hole. A fixture whose `tenantId` FIELD disagrees with its document
 * id therefore yields the id — record content cannot forge a prefix.
 *
 * ── The allow-list branch issues NO Firestore query at all (Req 4.6) ──────────
 *
 * Duplicates and blanks are dropped and the configured order is preserved, which
 * is deterministic for a given list — Req 1.10's requirement, met without a read.
 *
 * ── The `all_active` branch is `forEachQueryDocPaged`, unchanged ──────────────
 *
 * Same loop, same `orderBy('__name__')`, same snapshot cursor, same two stop
 * conditions — the only difference is the equality filter's field. So this query
 * stops being the one unbounded read left in the job without introducing a second
 * paging implementation that can drift from the first. Ascending document-name
 * order (Req 4.4) and de-duplication (Req 4.8) both fall out of it: the walk is
 * name-ordered and visits each document once, and the `Set` makes "once per run"
 * true even if a future filter could match a document twice.
 *
 * Only the id STRINGS are retained; every page's snapshots are released before the
 * next page is requested (Req 4.3).
 *
 * ── A FAILURE ON ANY PAGE PROPAGATES: no tenant is swept, the runner exits
 * non-zero (Req 4.7) — and this is deliberately NOT confined per-tenant the way a
 * listing failure is ────────────────────────────────────────────────────────────
 *
 * Task 3.1's confinement is right for a tenant, because "we could not sweep THIS
 * tenant" is a fact with a name attached: it is counted, logged, alerted on and
 * red. A partial tenant LIST has no such name. It is indistinguishable from a
 * smaller estate — every tenant it omits looks exactly like a tenant that does not
 * exist — so a run that swept "the tenants we managed to enumerate" is a green run
 * that has quietly stopped covering half the estate, and nothing in the report
 * would say so. So this one throws, before the loop, and the whole run is visibly
 * failed.
 */
async function resolveSweepTenantIds(
  db: Firestore,
  configured: string[] | 'all_active',
  pageSize: number
): Promise<string[]> {
  if (Array.isArray(configured)) {
    const seen = new Set<string>();
    for (const value of configured) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) seen.add(trimmed);
    }
    return Array.from(seen);
  }

  const seen = new Set<string>();
  await forEachQueryDocPaged({
    db,
    collection: 'tenants',
    field: 'status',
    value: 'active',
    pageSize: normalisePositiveInt(pageSize, DEFAULT_FIRESTORE_PAGE_SIZE),
    // Nothing can cancel the tenant list: there is no ceiling on it and a partial
    // list is the failure this walk must not produce quietly.
    shouldStop: () => false,
    // `docId` IS `doc.id`. The document's DATA is ignored entirely — it is not read
    // for the identifier, and it is not read for the `status` either, which the
    // query already filtered on.
    handler: (_data, docId) => {
      const trimmed = typeof docId === 'string' ? docId.trim() : '';
      if (trimmed) seen.add(trimmed);
    },
  });
  return Array.from(seen);
}
