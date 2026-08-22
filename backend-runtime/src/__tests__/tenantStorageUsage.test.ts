/**
 * `src/lib/tenantStorageUsage.ts` — the ONE authoritative quota recompute.
 *
 * ── Why this file exists, and what it is actually pinning ───────────────────
 *
 * `sumStoragePrefixBytes` documents itself as "Pages with `pageToken` and never
 * materialises the whole listing, which is the pagination shape the orphan sweep's
 * own listing loop copies". Against the real `@google-cloud/storage` client that
 * claim was false, and the reason is worth writing down because nothing about the
 * function's shape reveals it.
 *
 * `Bucket#getFiles` is wrapped by `@google-cloud/paginator`, whose `autoPaginate`
 * defaults to TRUE. Under that default `paginator.run_` does not hand back one
 * page: it drives a `ResourceStream` to exhaustion, collects **every** object of
 * the prefix into one array, and only then resolves
 * `[allResults, query, ...otherArgs]` — where `otherArgs[0]` is the `apiResponse`
 * of the LAST request, whose `nextPageToken` is by definition absent. So
 * `nextPageToken = response?.nextPageToken` was `undefined` on the first
 * iteration, the `do/while` ran exactly once, and the whole listing was resident
 * anyway.
 *
 * That is survivable in the request path it came from. It is not survivable in the
 * orphan sweep, which calls this once per tenant per run inside a Cloud Run job
 * sized at 512 MiB on the explicit reasoning that "the listing is paged and only
 * one page is held at a time".
 *
 * The fix is `autoPaginate: false`, which makes `paginator.run_` call the
 * underlying method directly and resolve `[files, nextQuery, apiResponse]` for ONE
 * page — at which point the `do/while` that was already written becomes the loop
 * it was meant to be. The sum is unchanged and the number of requests to GCS is
 * unchanged; only the peak resident set differs. These tests pin the flag, because
 * against a fake bucket the flag is the only observable difference — the real
 * difference lives in the client.
 */

import { estimateTenantStorageBytes, sumStoragePrefixBytes } from '../lib/tenantStorageUsage';
import { STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';

interface ListCall {
  prefix: string | undefined;
  pageToken: string | undefined;
  autoPaginate: boolean | undefined;
}

/**
 * A bucket that hands back exactly one page per call and a token for the next,
 * i.e. the shape the real client presents ONLY when `autoPaginate` is false.
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
      const nextPageToken =
        remaining.length > pageSize ? page[page.length - 1].name : undefined;
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

describe('sumStoragePrefixBytes pages rather than materialising the prefix', () => {
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
    // loop above is what advances the cursor and only one page is ever resident.
    for (const call of bucket.calls) {
      expect(call.autoPaginate).toBe(false);
      expect(call.prefix).toBe('chat-files/acme/');
    }
    expect(bucket.calls[0].pageToken).toBeUndefined();
    expect(bucket.calls[1].pageToken).toBeDefined();
    expect(bucket.calls[2].pageToken).toBeDefined();
  });

  it('skips excluded paths and contributes zero for an unusable size', async () => {
    const bucket = pagingBucket(
      [
        { name: 'receipts/acme/a.pdf', size: '100' },
        { name: 'receipts/acme/b.pdf', size: 'not-a-number' },
        { name: 'receipts/acme/c.pdf', size: '-5' },
        { name: 'receipts/acme/d.pdf', size: undefined },
        { name: 'receipts/acme/e.pdf', size: 250 },
        { name: 'receipts/acme/excluded.pdf', size: '9999' },
      ],
      2
    );

    const total = await sumStoragePrefixBytes(
      bucket as never,
      'receipts/acme/',
      new Set(['receipts/acme/excluded.pdf'])
    );

    expect(total).toBe(350);
  });
});

describe('estimateTenantStorageBytes', () => {
  it('sums exactly the six managed prefixes, one page at a time, and excludes originalDeleted originals', async () => {
    const original = 'chat-files/acme/video.mp4';
    const objects = [
      { name: 'chat-files/acme/photo.jpg', size: '100' },
      { name: original, size: '5000' },
      { name: 'notices/acme/n.png', size: '20' },
      { name: 'receipts/acme/r.pdf', size: '30' },
      { name: 'student_profiles/acme/s.jpg', size: '40' },
      { name: 'tenant-branding/acme/logo.png', size: '50' },
      { name: 'profile-pictures/acme/aaaaaaaaaaaaaaaaaaaa.jpg', size: '60' },
      // The quarantine namespace is deliberately not a managed category, so these
      // bytes have already left the tenant's quota.
      { name: '_orphan-quarantine/acme/sweep_1/notices/acme/gone.png', size: '999999' },
    ];
    const bucket = pagingBucket(objects, 1);

    const db = {
      collection: () => ({
        where: () => ({
          where: () => ({
            get: async () => ({
              forEach: (callback: (doc: { data(): Record<string, unknown> }) => void) => {
                callback({ data: () => ({ originalPath: original }) });
              },
            }),
          }),
        }),
      }),
    };

    const total = await estimateTenantStorageBytes(bucket as never, ' acme ', db as never);

    // 100 + 20 + 30 + 40 + 50 + 60 — the 5000-byte original is excluded and the
    // quarantine copy is not under any summed prefix.
    expect(total).toBe(300);
    // One pass over the six managed prefixes, and nothing else.
    expect(new Set(bucket.calls.map((call) => call.prefix))).toEqual(
      new Set(STORAGE_TENANT_CATEGORIES.map((category) => `${category}/acme/`))
    );
    for (const call of bucket.calls) expect(call.autoPaginate).toBe(false);
  });

  it('proceeds with the full sum when the exclusion query fails', async () => {
    const bucket = pagingBucket([{ name: 'chat-files/acme/x.bin', size: '77' }], 10);
    const db = {
      collection: () => ({
        where: () => ({
          where: () => ({
            get: async () => {
              throw new Error('permission denied');
            },
          }),
        }),
      }),
    };

    await expect(estimateTenantStorageBytes(bucket as never, 'acme', db as never)).resolves.toBe(77);
    expect(consoleWarn).toHaveBeenCalled();
  });
});
