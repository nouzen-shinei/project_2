import { QUARANTINE_PREFIX, classifyTenantScopedPath } from './storageObjectRef';

/**
 * The whole safety judgement of the orphan sweep, extracted so that "is this
 * object an orphan?" is answered by a pure, total function with no I/O and no
 * clock read — and can therefore be asserted over generated input before any
 * code exists that is able to move an object.
 *
 * Same posture as `src/lib/storageObjectRef.ts` and `src/lib/uploadObjectPath.ts`:
 * no `express`, no `firebase-admin`, no bucket handle. The only import is the
 * scope predicate and the quarantine namespace, both themselves pure.
 *
 * ── The asymmetry the whole module encodes ───────────────────────────────────
 *
 * A false positive destroys user data; a false negative wastes bytes. So this
 * function computes a *positive proof* of "unreferenced" and returns
 * `action: 'report'` only when every conjunct of that proof holds. Every other
 * input — malformed, missing, contradictory or merely unusual — retains.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;

/**
 * Grace_Period default. Seven days covers the gap between storing bytes and
 * writing the record across a weekend of retries; see the design's
 * "`graceDays` — why the default is 7".
 */
export const DEFAULT_GRACE_DAYS = 7;

/** Quarantine retention before the hard delete stage will consider an object. */
export const DEFAULT_QUARANTINE_RETENTION_DAYS = 7;

// ─── The decision inputs ─────────────────────────────────────────────────────

export interface ObjectFacts {
  /** `file.name` from `bucket.getFiles()` — the authoritative path spelling. */
  objectPath: string;
  /**
   * Epoch-ms of the MOST RECENT of the object's `timeCreated` and `updated`
   * metadata, or `null` when neither parses. Taking the max is the conservative
   * direction: a recently-touched object reads as YOUNG and is therefore
   * retained. A GCS overwrite creates a new generation with a fresh
   * `timeCreated`, so an `upload-idempotency` retry correctly re-enters the
   * grace window.
   */
  lastTouchedMs: number | null;
  /**
   * `Number(metadata.size)`, or `null` when absent/unparseable. Reporting only —
   * it never influences the action, so an unreadable size cannot become a
   * deletion input.
   */
  bytes: number | null;
}

export interface DecisionContext {
  tenantId: string;
  /**
   * Proven references, plus every derived exemption. Byte-comparable with
   * `objectPath`: membership is tested by exact string equality against the
   * `file.name` spelling the listing returned, because a retain path that does
   * not compare equal to the listing spelling is a deletion, not a mismatch.
   */
  retainPaths: ReadonlySet<string>;
  /**
   * Objects last touched at or after this instant are retained regardless of
   * references. Computed ONCE per run by `computeGraceCutoffMs` and injected, so
   * a multi-hour sweep cannot have its cutoff drift underneath it and start
   * judging objects it retained an hour earlier.
   */
  graceCutoffMs: number;
}

export type ObjectDisposition =
  | {
      action: 'retain';
      reason:
        | 'referenced' // in retainPaths — the ordinary case
        | 'within_grace' // not provably older than the grace cutoff
        | 'age_unknown' // lastTouchedMs unusable: cannot prove it is old
        | 'unmanaged_path' // not {category}/{tenantId}/… — never ours to judge
        | 'quarantine_path'; // already under QUARANTINE_PREFIX
    }
  | { action: 'report'; reason: 'unreferenced' };

// ─── Internals ───────────────────────────────────────────────────────────────

function retain(reason: Extract<ObjectDisposition, { action: 'retain' }>['reason']): ObjectDisposition {
  return { action: 'retain', reason };
}

/**
 * Whether a path lies in the quarantine namespace, tested at the segment
 * boundary rather than by a raw `startsWith`, so a sibling name such as
 * `_orphan-quarantine-old/x` is not mislabelled as quarantine. Both shapes
 * retain either way — only the recorded reason differs — but the reason is what
 * an operator reads on the report.
 */
function isQuarantinePath(objectPath: string): boolean {
  return objectPath === QUARANTINE_PREFIX || objectPath.startsWith(`${QUARANTINE_PREFIX}/`);
}

/**
 * Reduce `lastTouchedMs` to "a usable epoch-ms" or `null`. `NaN`, `Infinity`,
 * `-Infinity`, a negative value and a non-number are all `null`: none of them is
 * a time at which an object could have been touched, and a value we cannot read
 * is not a value we can use to prove age (Req 1.8).
 */
function usableLastTouchedMs(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

// ─── The decision ────────────────────────────────────────────────────────────

/**
 * The one place "is this an orphan?" is answered.
 *
 * **Evaluation order is part of the contract**, and it is safety-first rather
 * than cheap-first: `scope → quarantine → referenced → grace → age`.
 *
 *  - **Scope precedes everything** so a cross-tenant path can never reach a
 *    comparison it might pass by coincidence. A path outside this tenant's
 *    managed prefixes is retained before `retainPaths` or the cutoff is ever
 *    consulted.
 *  - **Quarantine is next**, and because `QUARANTINE_PREFIX` is deliberately not
 *    a Managed_Category, a quarantine path has *already* failed the scope test by
 *    the time it is recognised. The quarantine test therefore refines the reason
 *    of that scope failure from `unmanaged_path` to the more specific
 *    `quarantine_path` (Req 1.7); it never changes the action, which is `retain`
 *    on both branches. That is the only reading of the documented order under
 *    which both Req 1.6 and Req 1.7 are reachable.
 *  - **`age_unknown` is last** so that a referenced object with unreadable
 *    metadata still reports the honest `referenced` rather than hiding behind its
 *    missing timestamps.
 *
 * `action: 'report'` is returned ONLY when all five conjuncts hold: the path is
 * in this tenant's managed scope, is not under `QUARANTINE_PREFIX`, is absent
 * from `retainPaths`, has a usable `lastTouchedMs`, and that `lastTouchedMs` is
 * strictly earlier than `graceCutoffMs`. Negating any single conjunct yields
 * `retain` — that contrapositive is the property that matters (Property 1).
 *
 * Monotone in the retain set: adding a path can only turn `report` into
 * `retain`, never the reverse, so over-collecting references is always safe.
 *
 * Total and pure: exactly one disposition for every input, no throw, no I/O, no
 * clock read. `facts.bytes` is never consulted.
 */
export function decideObjectDisposition(
  facts: ObjectFacts,
  context: DecisionContext
): ObjectDisposition {
  // `file.name` is a string in every real listing; a non-string is normalised to
  // `''` here rather than trusted, and falls out of the scope test below.
  const objectPath = typeof facts.objectPath === 'string' ? facts.objectPath : '';

  // 1. Scope. Failing this is decided before any other input is read.
  if (!classifyTenantScopedPath(objectPath, context.tenantId).ok) {
    // 2. Quarantine. Reached only through a scope failure — the two domains are
    // provably disjoint — so this refines the reason, not the action.
    return retain(isQuarantinePath(objectPath) ? 'quarantine_path' : 'unmanaged_path');
  }

  // Defence in depth. Unreachable while `QUARANTINE_PREFIX` stays out of
  // `STORAGE_TENANT_CATEGORIES`; if it ever crept in, a quarantined object must
  // still never be judged as a live one.
  if (isQuarantinePath(objectPath)) {
    return retain('quarantine_path');
  }

  // 3. Referenced. Exact string equality against the listing spelling, and it
  // wins over age: a referenced object is never a candidate however old it is.
  if (context.retainPaths.has(objectPath)) {
    return retain('referenced');
  }

  const lastTouchedMs = usableLastTouchedMs(facts.lastTouchedMs);

  // 4. Grace. Written as a positive proof of "older than the cutoff" rather than
  // as its negation, so a `graceCutoffMs` that is itself `NaN` retains instead
  // of reporting: `lastTouchedMs < NaN` is false, and the safe direction is to
  // treat "not provably older" as within grace.
  if (lastTouchedMs !== null && !(lastTouchedMs < context.graceCutoffMs)) {
    return retain('within_grace');
  }

  // 5. Age. Last, so the branches above can report their own, more informative
  // reasons for an object whose metadata is unreadable.
  if (lastTouchedMs === null) {
    return retain('age_unknown');
  }

  // In scope, not quarantined, unreferenced, and provably older than the cutoff.
  return { action: 'report', reason: 'unreferenced' };
}

/**
 * `nowMs - graceDays * DAY_MS`, and nothing more (Req 2.5).
 *
 * Pure: the sweep injects `nowMs` once per run so a long run cannot drift. No
 * clamping or defaulting happens here — a non-finite or non-positive
 * `graceDays` falls back to `DEFAULT_GRACE_DAYS` in the runner, where the
 * configuration is parsed, so this function stays the plain arithmetic its
 * postcondition says it is.
 */
export function computeGraceCutoffMs(nowMs: number, graceDays: number): number {
  return nowMs - graceDays * DAY_MS;
}
