import type { firestore as FirestoreNS, storage as StorageNS } from 'firebase-admin';

/**
 * The authoritative recompute of a tenant's recorded storage usage from bucket
 * truth, and the paged per-prefix sum it is built from.
 *
 * Both functions were module-private in `src/app.ts` until now, which is why
 * `__tests__/estimateTenantStorageBytes.property.test.ts` re-implements the
 * summing logic inline and says so in a comment. They are moved here unchanged —
 * same summed prefixes, same `videoTranscodes` `originalDeleted` exclusion, same
 * `getFiles` pagination shape, same `clearTimeout`-in-`finally` on the exclusion
 * query race — and imported back into `app.ts`, so exactly one implementation
 * exists. `POST /storage/reconcile`, the usage bootstrap and the orphan sweep's
 * one post-sweep recompute per tenant all call this same function.
 *
 * The prefixes summed are exactly the Managed_Categories from
 * `src/lib/storageObjectRef.ts`. The quarantine namespace is deliberately not
 * among them, so a quarantined object leaves the tenant's quota the moment it
 * moves while staying recoverable, and a quarantine copy whose delete failed
 * over-counts rather than under-counts until the next recompute.
 */

import { STORAGE_TENANT_CATEGORIES } from './storageObjectRef';

type StorageBucket = ReturnType<StorageNS.Storage['bucket']>;

/**
 * Sum the sizes of every object under `prefix`, skipping any path in
 * `excludePaths`.
 *
 * Pages with `pageToken` and never materialises the whole listing, which is the
 * pagination shape the orphan sweep's own listing loop copies. An unparseable or
 * non-positive size contributes zero rather than `NaN`.
 *
 * ── `autoPaginate: false` is what makes the loop below real ──────────────────
 *
 * This is the one line that is NOT inherited from the `app.ts` original, and it is
 * a correction rather than a tidy-up. `Bucket#getFiles` is wrapped by
 * `@google-cloud/paginator`, whose `autoPaginate` defaults to TRUE — and under that
 * default `paginator.run_` does not return a page. It drives a `ResourceStream` to
 * exhaustion, collects EVERY object under the prefix into one array, and resolves
 * `[allResults, query, ...otherArgs]` where `otherArgs[0]` is the `apiResponse` of
 * the LAST request, whose `nextPageToken` is by definition absent. So
 * `nextPageToken` was `undefined` on the first iteration, this `do/while` ran
 * exactly once, and the whole listing was resident regardless of what the loop
 * said.
 *
 * Harmless in the request path this came from; not harmless in the orphan sweep,
 * which calls `estimateTenantStorageBytes` once per tenant per run inside a Cloud
 * Run job sized at 512 MiB on the stated reasoning that "the listing is paged and
 * only one page is held at a time" — and which fans the six prefixes out
 * CONCURRENTLY through `Promise.all`, so the peak was six whole prefixes at once.
 *
 * With the flag, `paginator.run_` calls the underlying method directly and resolves
 * `[files, nextQuery, apiResponse]` for one page. Same objects visited, same number
 * of requests to GCS, same sum; one page resident instead of all of them. The
 * orphan sweep's own `listObjectPage` sets the same flag for the same reason.
 */
export async function sumStoragePrefixBytes(
  bucket: StorageBucket,
  prefix: string,
  excludePaths: Set<string> = new Set()
): Promise<number> {
  let total = 0;
  let nextPageToken: string | undefined;
  do {
    const [files, , response] = await bucket.getFiles({
      prefix,
      pageToken: nextPageToken,
      autoPaginate: false,
    });
    files.forEach((file) => {
      if (excludePaths.has(file.name)) return;
      const sizeRaw = (file.metadata as any)?.size;
      const size = typeof sizeRaw === 'string' ? Number(sizeRaw) : typeof sizeRaw === 'number' ? sizeRaw : 0;
      if (Number.isFinite(size) && size > 0) {
        total += size;
      }
    });
    nextPageToken = (response as any)?.nextPageToken;
  } while (nextPageToken);
  return total;
}

export async function estimateTenantStorageBytes(
  bucket: StorageBucket,
  tenantId: string,
  db?: FirestoreNS.Firestore
): Promise<number> {
  const normalizedTenantId = tenantId.trim();
  // Derived from the shared tuple rather than spelled out again: a seventh
  // Managed_Category must start counting against quota and become sweepable in
  // the same edit. The tuple's order differs from the list this replaced, which
  // is immaterial — the six per-prefix sums are added together below, so the
  // total is order-independent.
  const prefixes = STORAGE_TENANT_CATEGORIES.map((category) => `${category}/${normalizedTenantId}/`);

  // Query videoTranscodes for originalDeleted files to exclude from byte total.
  // Per requirements 3.8 and 3.9: if query fails or times out, log a warning and
  // proceed with the full sum (temporarily inflated until next reconciliation).
  let excludePaths = new Set<string>();
  if (db) {
    // Cleared in the `finally` below once the race settles. Without that the
    // 5s guard timer stays pending for its full duration after the query has
    // already answered, keeping the event loop alive — invisible in the
    // long-lived server, but it holds a short-lived process (a job script, a
    // test run) open for five seconds after its work is done.
    let excludeQueryTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const EXCLUDE_QUERY_TIMEOUT_MS = 5000;
      const deletedQueryPromise = db
        .collection('videoTranscodes')
        .where('tenantId', '==', normalizedTenantId)
        .where('originalDeleted', '==', true)
        .get();
      const timeoutPromise = new Promise<never>((_, reject) => {
        excludeQueryTimeout = setTimeout(
          () => reject(new Error('videoTranscodes exclusion query timed out')),
          EXCLUDE_QUERY_TIMEOUT_MS
        );
      });
      const deletedSnap = await Promise.race([deletedQueryPromise, timeoutPromise]);
      deletedSnap.forEach((doc: FirestoreNS.QueryDocumentSnapshot) => {
        const originalPath: unknown = doc.data().originalPath;
        if (typeof originalPath === 'string' && originalPath.length > 0) {
          excludePaths.add(originalPath);
        }
      });
    } catch (err) {
      console.warn(
        '[estimateTenantStorageBytes] Failed to query originalDeleted videoTranscodes; proceeding with full sum (may be temporarily inflated).',
        err instanceof Error ? err.message : err
      );
      excludePaths = new Set<string>(); // reset to empty — full sum
    } finally {
      if (excludeQueryTimeout !== undefined) {
        clearTimeout(excludeQueryTimeout);
      }
    }
  }

  const results = await Promise.all(
    prefixes.map((prefix) => sumStoragePrefixBytes(bucket, prefix, excludePaths).catch(() => 0))
  );
  return results.reduce((acc, value) => acc + value, 0);
}
