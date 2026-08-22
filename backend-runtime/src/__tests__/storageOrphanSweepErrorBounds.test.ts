/**
 * Bounding the two unbounded strings that reach the tenant report document.
 *
 * ── Why a bound and not a note ───────────────────────────────────────────────
 *
 * `describeThrownValue` returned a thrown string VERBATIM and untruncated, and its
 * output lands in two places on `storageMaintenanceJobs/{sweepId}/tenants/{tenantId}`:
 * `failedSources[].message` (via `collectTenantReferenceSet`) and `lastError` (via
 * the listing-loop catch and the quota recompute). Neither was bounded, and
 * Firestore rejects any document over 1,048,576 bytes.
 *
 * The realistic worst case for everything ELSE on that document is about 411 KB, so
 * there is headroom — an unbounded field is what closes it. What makes it worth
 * fixing rather than noting is the failure mode: the FINAL `writeTenantReport`
 * happens outside any try/catch, after the quarantine work and after the
 * `tenantStorageUsage` write, so a document that Firestore refuses means the report
 * is never finalised and `logTenantMetricDeltas()` never runs. A run that moved
 * objects would leave no record of having done so.
 *
 * `MAX_ERROR_MESSAGE_BYTES` is measured in BYTES rather than UTF-16 code units for
 * the same reason the GCS object-name limit is: the limit being modelled is a byte
 * limit, and a 2048-code-unit string of astral characters is 8192 bytes.
 */

import {
  describeThrownValue,
  MAX_ERROR_MESSAGE_BYTES,
  runStorageOrphanSweep,
  tenantReportPath,
} from '../jobs/storageOrphanSweep';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  iso,
  sweepConfig,
  type DocData,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
const OLD = iso(NOW - 120 * DAY);

const ELISION = '… [truncated]';

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

describe('describeThrownValue bounds its result', () => {
  it('returns a short message untouched', () => {
    expect(describeThrownValue(new Error('permission denied'))).toBe('permission denied');
    expect(describeThrownValue('a plain string')).toBe('a plain string');
  });

  it('truncates a thrown string past the bound, with a visible elision marker', () => {
    const huge = 'x'.repeat(200_000);

    const described = describeThrownValue(huge);

    expect(Buffer.byteLength(described, 'utf8')).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
    // Visibly truncated rather than merely short: a caller reading the report can
    // tell that the message was cut, not that the thrower was terse.
    expect(described.endsWith(ELISION)).toBe(true);
    expect(described.startsWith('xxx')).toBe(true);
  });

  it("truncates an Error's unbounded message the same way", () => {
    const described = describeThrownValue(new Error('y'.repeat(200_000)));

    expect(Buffer.byteLength(described, 'utf8')).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
    expect(described.endsWith(ELISION)).toBe(true);
  });

  it('bounds by BYTES, so an astral-plane message cannot be 4× the bound', () => {
    // Each of these is 2 UTF-16 code units and 4 UTF-8 bytes. A code-unit bound
    // would let this through at 4× the byte budget.
    const described = describeThrownValue('\u{1F600}'.repeat(50_000));

    expect(Buffer.byteLength(described, 'utf8')).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
    expect(described.endsWith(ELISION)).toBe(true);
    // Never split a code point: a lone surrogate would corrupt the stored string.
    expect(described).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(described).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('bounds the value coerced out of a non-Error object', () => {
    const described = describeThrownValue({ message: 'z'.repeat(200_000) });

    expect(Buffer.byteLength(described, 'utf8')).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
    expect(described.endsWith(ELISION)).toBe(true);
  });
});

describe('the report document `lastError` is bounded', () => {
  /**
   * Every non-null `lastError` written by this module already flows through
   * `describeThrownValue` — the listing-loop catch and both quota-recompute
   * catches are the only writers, and the pre-listing/progress writes use `null`.
   * This drives the real sweep so that claim is observed rather than asserted from
   * reading the code: bounding `describeThrownValue` must be sufficient to bound
   * the field.
   */
  it('truncates a listing failure that throws a 200 KB string', async () => {
    const log = createOperationLog();
    const db = createFakeFirestore({ log, collections: {} });
    const bucket = createFakeBucket({
      log,
      objects: [{ name: `notices/${TENANT}/n.png`, size: 10, timeCreated: OLD, updated: OLD }],
      // Fail only the PAGED listing; the quota recompute pages without `maxResults`.
      failGetFiles: (call) => (call.maxResults !== undefined ? 'e'.repeat(200_000) : undefined),
    });

    await expect(
      runStorageOrphanSweep({
        db: db as never,
        rtdb: createFakeRtdb({ log, tree: {} }) as never,
        bucket: bucket as never,
        config: sweepConfig({ tenantIds: [TENANT], nowMs: NOW }) as never,
      })
    ).rejects.toBeDefined();

    const report = db.read(tenantReportPath(TENANT)) as DocData;
    const lastError = report.lastError as string;
    expect(typeof lastError).toBe('string');
    expect(Buffer.byteLength(lastError, 'utf8')).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
    expect(lastError.endsWith(ELISION)).toBe(true);
  });
});
