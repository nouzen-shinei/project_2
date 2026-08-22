/**
 * `jobs/tenantUsageRollup.ts`'s own copy of the paged per-prefix sum.
 *
 * ── Why a second test file for the same helper ───────────────────────────────
 *
 * `src/__tests__/tenantStorageUsage.test.ts` pins `autoPaginate: false` on the
 * shared `sumStoragePrefixBytes` in `src/lib/tenantStorageUsage.ts`. The rollup
 * job carries a SECOND, private copy of the same helper — it differs (no
 * `excludePaths`, and a listing failure is swallowed into `0`) and merging the two
 * is a separate change — and that copy had the identical defect.
 *
 * The defect, restated so this file stands on its own: `Bucket#getFiles` is
 * wrapped by `@google-cloud/paginator`, whose `autoPaginate` defaults to TRUE.
 * Under that default `paginator.run_` drives a `ResourceStream` to exhaustion,
 * collects every object of the prefix into one array, and resolves
 * `[allResults, query, ...otherArgs]` where `otherArgs[0]` is the `apiResponse` of
 * the LAST request — whose `nextPageToken` is by definition absent. So the
 * `do { … } while (nextPageToken)` ran exactly once over an already fully
 * materialised listing.
 *
 * `usage-rollup-job` is a Cloud Run job with a bounded memory limit and it walks
 * this helper once per configured prefix per tenant, so a prefix that has grown
 * large would OOM it rather than page. These tests pin the flag on every request,
 * because against a fake bucket the flag is the only observable difference — the
 * real difference lives inside the client.
 */

import { sumStoragePrefixBytes } from '../jobs/tenantUsageRollup';

interface ListCall {
  prefix: string | undefined;
  pageToken: string | undefined;
  autoPaginate: boolean | undefined;
}

/**
 * A bucket that hands back exactly one page per call and a token for the next,
 * i.e. the shape the real client presents ONLY when `autoPaginate` is false.
 * Same fake as `tenantStorageUsage.test.ts`, deliberately, so the two copies of
 * the helper are held to the same contract.
 */
function pagingBucket(objects: { name: string; size: unknown }[], pageSize: number) {
  const calls: ListCall[] = [];
  const sorted = [...objects].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    calls,
    async getFiles(query: Record<string, unknown>) {
      calls.push({
        prefix: typeof query.prefix === 'string' ? query.prefix : undefined,
        pageToken: typeof query.pageToken === 'string' ? query.pageToken : undefined,
        autoPaginate: typeof query.autoPaginate === 'boolean' ? query.autoPaginate : undefined,
      });
      const prefix = typeof query.prefix === 'string' ? query.prefix : '';
      const cursor = typeof query.pageToken === 'string' ? query.pageToken : null;
      const matching = sorted.filter((object) => object.name.startsWith(prefix));
      const remaining = cursor === null ? matching : matching.filter((object) => object.name > cursor);
      const page = remaining.slice(0, pageSize);
      const nextPageToken = remaining.length > pageSize ? page[page.length - 1].name : undefined;
      return [
        page.map((object) => ({ name: object.name, metadata: { size: object.size } })),
        nextPageToken ? { pageToken: nextPageToken } : null,
        nextPageToken ? { nextPageToken } : {},
      ];
    },
  };
}

let consoleWarn: jest.SpyInstance;

beforeAll(() => {
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleWarn.mockRestore();
});

describe("the rollup's sumStoragePrefixBytes pages rather than materialising the prefix", () => {
  it('asks the client for ONE page at a time and follows the token to the end', async () => {
    const objects = Array.from({ length: 7 }, (_, index) => ({
      name: `chat-files/acme/obj_${index}.bin`,
      size: String(10 * (index + 1)),
    }));
    const bucket = pagingBucket(objects, 3);

    const total = await sumStoragePrefixBytes(bucket as never, 'chat-files/acme/');

    // 10+20+…+70
    expect(total).toBe(280);
    // Three pages: 3, 3, 1. The third returns fewer than `pageSize` and no token.
    expect(bucket.calls.length).toBe(3);
    // THE assertion: every request opts out of the client's own pagination, so the
    // loop in the job is what advances the cursor and only one page is ever
    // resident. Without the flag the real client would return the whole prefix on
    // the first call and this loop would run exactly once.
    for (const call of bucket.calls) {
      expect(call.autoPaginate).toBe(false);
      expect(call.prefix).toBe('chat-files/acme/');
    }
    expect(bucket.calls[0].pageToken).toBeUndefined();
    expect(bucket.calls[1].pageToken).toBeDefined();
    expect(bucket.calls[2].pageToken).toBeDefined();
  });

  it('contributes zero for an unusable size and still opts out of auto-pagination', async () => {
    const bucket = pagingBucket(
      [
        { name: 'receipts/acme/a.pdf', size: '100' },
        { name: 'receipts/acme/b.pdf', size: 'not-a-number' },
        { name: 'receipts/acme/c.pdf', size: '-5' },
        { name: 'receipts/acme/d.pdf', size: undefined },
        { name: 'receipts/acme/e.pdf', size: 250 },
      ],
      2
    );

    await expect(sumStoragePrefixBytes(bucket as never, 'receipts/acme/')).resolves.toBe(350);
    for (const call of bucket.calls) expect(call.autoPaginate).toBe(false);
  });

  it('swallows a listing failure into zero rather than failing the whole rollup', async () => {
    // The one behaviour that differs from the shared copy, pinned so a later merge
    // of the two cannot drop it silently.
    const bucket = {
      async getFiles() {
        throw new Error('storage.objects.list denied');
      },
    };

    await expect(sumStoragePrefixBytes(bucket as never, 'notices/acme/')).resolves.toBe(0);
    expect(consoleWarn).toHaveBeenCalled();
  });
});
