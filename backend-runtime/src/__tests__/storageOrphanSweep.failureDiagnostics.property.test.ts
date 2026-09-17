// Feature: storage-sweep-scale-hardening, Property 2: Failure diagnostics are total, bounded, and leak nothing
/**
 * Property 2: Failure diagnostics are total, bounded, and leak nothing
 * **Validates: Requirements 1.2, 1.3, 2.3, 10.1, 10.2**
 *
 * *For any* thrown value — an `Error`, a permission error, a timeout, a string, a
 * number, `null`, `undefined`, a symbol, an object whose `message` getter throws,
 * an object whose `toString` throws, a 10 kB message, and a message containing an
 * object path, a filename, an email address and a download token — the recorded
 * `failureMessage` is a non-empty string within `MAX_ERROR_MESSAGE_BYTES`, and **no
 * new metric label value** contains any of the path, filename, email or token
 * substrings the fixture planted.
 *
 * ── The two clauses are separate on purpose ──────────────────────────────────
 *
 * The coerced error text is the operator's only diagnostic for a tenant that was
 * not swept, and it is permitted to carry whatever the thrower put in it — that is
 * why the first clause bounds it rather than sanitising it. A *metric label* is
 * unbounded-cardinality data in a monitoring system and must carry none of it
 * (Req 10.1, 10.2). `SweepMetricLabels` is a closed type, so half of that is
 * structural; what this property asserts is the other half, that nothing generated
 * reaches a label VALUE.
 *
 * ── Why the thrown value is injected at the listing, and how ─────────────────
 *
 * The harness's own `failGetFiles` seam cannot express `throw undefined` — it uses
 * `undefined` to mean "do not fail" — so the bucket is wrapped here instead. That
 * matters: `undefined` is one of the values Requirement 1.2 names, and it is the
 * one a naive `error.message` read fails on.
 *
 * No precondition here is established by catching an exception (Req 11.26): the
 * confinement records the failure as a returned result, and every generated input
 * is asserted against it — there is no arm, no early return and nothing skipped, so
 * the run counter below is the whole vacuity guard this property needs.
 */

import * as fc from 'fast-check';

import {
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
  type FakeBucket,
  type FakeObject,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
const OLD = iso(NOW - 120 * DAY);

/** The closed label set `SweepMetricLabels` permits (Req 10.1). */
const LABEL_KEYS = ['tenant_id', 'mode', 'reason', 'outcome', 'abort_reason'] as const;

/**
 * The four categories of unbounded, leak-prone data Req 10.2 keeps out of every
 * label and every new log line. Planted at the FRONT of the generated message, so
 * the byte bound cannot remove them and "the message carried it, the labels did
 * not" stays an assertion about both halves rather than only the second.
 */
const NEEDLES = [
  `notices/${TENANT}/notice_k_2f9a1c_confidential.png`,
  'march-invoice-scan.pdf',
  'parent.name@example.com',
  '?token=8f14e45f-ceea-467a-9f57-2b9c7d4f0a11',
] as const;

interface MetricLine {
  metric: string;
  value: number;
  [key: string]: unknown;
}

let consoleLog: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;
let exitCodeAtStart: typeof process.exitCode;

beforeAll(() => {
  exitCodeAtStart = process.exitCode;
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
  // Nothing here writes `process.exitCode` — the confinement records the failure
  // and the runner's own seam is not invoked — so a leak would be a real defect
  // rather than housekeeping: it would make the whole jest process exit non-zero
  // with every test green.
  const leaked = process.exitCode;
  process.exitCode = exitCodeAtStart;
  expect(leaked).toBe(exitCodeAtStart);
});

function metricLines(): MetricLine[] {
  const lines: MetricLine[] = [];
  for (const call of consoleLog.mock.calls) {
    const first = call[0];
    if (typeof first !== 'string' || !first.startsWith('{') || !first.includes('"metric"')) continue;
    const parsed = JSON.parse(first) as MetricLine;
    if (typeof parsed.metric === 'string') lines.push(parsed);
  }
  return lines;
}

/** Every label VALUE emitted anywhere in the run — never a `metric` or a `value`. */
function allLabelValues(lines: MetricLine[]): string[] {
  const values: string[] = [];
  for (const line of lines) {
    for (const key of LABEL_KEYS) {
      const value = line[key];
      if (typeof value === 'string') values.push(value);
    }
  }
  return values;
}

const objects: FakeObject[] = [
  { name: `notices/${TENANT}/notice_k_a.png`, size: 10, timeCreated: OLD, updated: OLD },
];

/**
 * Run one sweep whose first PAGED listing call throws `thrown`, whatever it is.
 *
 * The bucket is wrapped rather than configured because `failGetFiles` reserves
 * `undefined` for "do not fail", and `undefined` is one of the thrown values
 * Requirement 1.2 enumerates. The quota recompute pages without `maxResults` and is
 * left working, so only the listing fails.
 */
async function sweepThrowing(thrown: unknown) {
  const log = createOperationLog();
  const base = createFakeBucket({ log, objects });
  let pagedSeen = 0;
  const bucket: FakeBucket = {
    ...base,
    async getFiles(query: Record<string, unknown>) {
      if (typeof query.maxResults === 'number') {
        pagedSeen += 1;
        if (pagedSeen === 1) throw thrown;
      }
      return base.getFiles(query);
    },
  };
  const db = createFakeFirestore({ log, collections: {} });

  consoleLog.mockClear();
  const result = await runStorageOrphanSweep({
    db: db as never,
    rtdb: createFakeRtdb({ log, tree: {} }) as never,
    bucket: bucket as never,
    config: sweepConfig({ tenantIds: [TENANT], nowMs: NOW }) as never,
  });

  return { result, db, lines: metricLines() };
}

describe('Property 2: failure diagnostics are total, bounded, and leak nothing', () => {
  it('coerces ANY thrown value into a non-empty, byte-bounded failureMessage', async () => {
    // Every generated input reaches the assertions below — there is no arm and no
    // early return — so counting the runs is the whole vacuity guard: a property
    // whose body never executed would pass, and this is what stops it (Req 11.25).
    let observed = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          { arbitrary: fc.anything(), weight: 5 },
          // Explicitly, because `fc.anything()` generates none of these.
          { arbitrary: fc.constant(undefined), weight: 1 },
          { arbitrary: fc.string().map((text) => Symbol(text)), weight: 1 },
          { arbitrary: fc.string().map((text) => new Error(text)), weight: 1 },
          {
            arbitrary: fc.string().map((text) => ({
              get message(): string {
                throw new Error(text || 'the message getter exploded');
              },
            })),
            weight: 1,
          },
          {
            arbitrary: fc.string().map((text) => ({
              toString(): string {
                throw new Error(text || 'toString exploded');
              },
            })),
            weight: 1,
          },
          // A 10 kB message, and a 10 kB thrown STRING: the two shapes whose
          // untruncated forms would have reached the Report_Document.
          {
            arbitrary: fc
              .integer({ min: 10_000, max: 12_000 })
              .map((length) => new Error('m'.repeat(length))),
            weight: 1,
          },
          {
            arbitrary: fc.integer({ min: 10_000, max: 12_000 }).map((length) => 's'.repeat(length)),
            weight: 1,
          },
          // Astral-plane characters, where a code-unit bound would be 4x the byte
          // budget.
          {
            arbitrary: fc
              .integer({ min: 2_000, max: 4_000 })
              .map((length) => '\u{1F600}'.repeat(length)),
            weight: 1,
          }
        ),
        async (thrown) => {
          observed += 1;
          const { result, db } = await sweepThrowing(thrown);

          // Req 1.1: recorded, not raised. Req 1.11: counted.
          const [tenant] = result.tenants;
          expect(tenant.status).toBe('failed');
          expect(result.tenantFailures).toBe(1);

          // Req 1.2, 1.3: total and bounded, for every thrown value alike.
          const message = tenant.failureMessage;
          expect(typeof message).toBe('string');
          expect((message as string).length).toBeGreaterThan(0);
          expect(Buffer.byteLength(message as string, 'utf8')).toBeLessThanOrEqual(
            MAX_ERROR_MESSAGE_BYTES
          );
          // Never a half code point: a lone surrogate would corrupt the stored
          // string, and this is the input shape that produces one.
          expect(message as string).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
          expect(message as string).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);

          // The same coercion reached the Report_Document, bounded the same way.
          const report = db.read(tenantReportPath(TENANT));
          expect(report).toBeDefined();
          expect(report!.status).toBe('failed');
          expect(Buffer.byteLength(report!.lastError as string, 'utf8')).toBeLessThanOrEqual(
            MAX_ERROR_MESSAGE_BYTES
          );
        }
      ),
      { numRuns: 100 }
    );

    expect(observed).toBeGreaterThanOrEqual(100);
  });

  it('lets the planted path, filename, email and token reach the message and NO metric label', async () => {
    let observed = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...NEEDLES), { minLength: 1, maxLength: NEEDLES.length }),
        // Sometimes past the byte bound, so truncation is exercised alongside the
        // leak check rather than in a separate case.
        fc.integer({ min: 0, max: 3_000 }),
        fc.boolean(),
        async (needles, padding, asError) => {
          observed += 1;
          // The needles go FIRST: the bound cuts the tail, so a planted substring
          // surviving truncation is what makes the message half of this property an
          // assertion rather than an accident.
          const text = `${needles.join(' | ')} ${'p'.repeat(padding)}`;
          const { result, lines } = await sweepThrowing(asError ? new Error(text) : text);

          const [tenant] = result.tenants;
          expect(tenant.status).toBe('failed');
          const message = tenant.failureMessage as string;

          // Clause one: the operator's diagnostic kept what the thrower put in it.
          for (const needle of needles) {
            expect(message).toContain(needle);
          }

          // Clause two: not one label value carries any of it — nor the generic
          // shapes a partial leak would take.
          const values = allLabelValues(lines);
          expect(values.length).toBeGreaterThan(0);
          for (const value of values) {
            for (const needle of needles) {
              expect(value).not.toContain(needle);
            }
            expect(value).not.toContain('@');
            expect(value).not.toContain('token=');
            expect(value).not.toContain('.pdf');
            expect(value).not.toContain('.png');
            expect(value).not.toContain('/');
          }

          // And no label KEY outside the closed set exists to carry it either.
          for (const line of lines) {
            for (const key of Object.keys(line)) {
              expect(['severity', 'message', 'metric', 'value', ...LABEL_KEYS]).toContain(key);
            }
          }
        }
      ),
      { numRuns: 100 }
    );

    expect(observed).toBeGreaterThanOrEqual(100);
  });
});
