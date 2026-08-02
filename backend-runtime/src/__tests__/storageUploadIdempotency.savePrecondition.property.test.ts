// Feature: upload-idempotency, Property 14: A lost precondition race is a success, never an error
/**
 * Property 14: A lost precondition race is a success, never an error
 *
 * For any precondition, any shape a `412 Precondition Failed` can arrive in, any
 * outcome of the re-probe that follows it (found with a token, found without one,
 * absent, or a probe that itself rejects) and any download-token attribution,
 * `saveUploadObjectWithPrecondition` resolves — never rejects — as long as no
 * non-412 write failure occurred; it issues at most two write attempts and never a
 * second one after reporting a lost race; the re-probe always precedes any fallback
 * write; and it reports `releaseReservation: true` only when the stored object
 * provably is not this request's own write. A non-412 write failure is re-thrown
 * with reference identity, so the route's existing rollback and `500 upload_failed`
 * are reached exactly as before.
 *
 * **Validates: Requirements 4.1, 4.2, 9.5, 9.9, 9.10, 9.11, 9.12**
 *
 * ---------------------------------------------------------------------------
 * Why this is worth a property test
 * ---------------------------------------------------------------------------
 * This is the single highest-risk part of the concurrency fix. Mis-classifying a
 * precondition failure would turn working uploads into `500`s — far worse than the
 * inflated usage counter the fix exists to remove. The failure would also be
 * invisible in the common case: a race needs two attempts in flight at once, so an
 * example test exercises the recovery only where the author remembered to. What
 * varies here is exactly what production varies: where the status lives on the
 * error, whether the sibling's object is still there a moment later, and whether the
 * stored token can attribute the write.
 *
 * The order of operations is asserted, not just the outcome, because it is the part
 * that cannot be inferred from the result: probing before releasing is what keeps
 * the endpoint from releasing bytes that are still its own, and from writing bytes
 * it no longer holds a reservation for.
 *
 * ---------------------------------------------------------------------------
 * Harness notes
 * ---------------------------------------------------------------------------
 * - The REAL exported seam is driven. The `save` and `reprobe` collaborators are the
 *   only fakes, and both record into one ordered call log.
 * - Generators emit plain-data SPECS; the hostile error carriers are materialized in
 *   the property body, so fast-check never has to stringify a throwing getter to
 *   report a counterexample.
 */

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import * as fc from 'fast-check';

import {
  isStoragePreconditionFailed,
  saveUploadObjectWithPrecondition,
  type ExistingUploadObject,
  type UploadObjectWriteResult,
  type UploadSavePrecondition,
} from '../app';

const NUM_RUNS = 300;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

type StatusField = 'code' | 'statusCode' | 'status' | 'response.status';

const statusFieldArb = fc.constantFrom<StatusField>('code', 'statusCode', 'status', 'response.status');

/** How a 412 arrives. Every variant must be recognized. */
type PreconditionErrorSpec = { field: StatusField; asString: boolean; asError: boolean };

const preconditionErrorArb: fc.Arbitrary<PreconditionErrorSpec> = fc.record({
  field: statusFieldArb,
  asString: fc.boolean(),
  asError: fc.boolean(),
});

/** A write failure that is emphatically NOT a lost race. */
type OtherErrorSpec =
  | { kind: 'http'; status: number; field: StatusField }
  | { kind: 'plain' }
  | { kind: 'nonError'; value: 'string' | 'number' | 'null' | 'undefined' | 'object' }
  | { kind: 'throwingGetter' };

const otherErrorArb: fc.Arbitrary<OtherErrorSpec> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('http' as const),
      // 4120 / 41 are near-misses; 411 and 413 straddle 412.
      status: fc.constantFrom(0, 41, 400, 403, 404, 409, 411, 413, 429, 500, 502, 503, 4120),
      field: statusFieldArb,
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'plain' as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('nonError' as const),
      value: fc.constantFrom('string', 'number', 'null', 'undefined', 'object'),
    }) as fc.Arbitrary<OtherErrorSpec>,
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'throwingGetter' as const }) },
);

function materializePreconditionError(spec: PreconditionErrorSpec): unknown {
  const carrier: any = spec.asError ? new Error('precondition failed') : {};
  const raw = spec.asString ? '412' : 412;
  if (spec.field === 'response.status') carrier.response = { status: raw };
  else carrier[spec.field] = raw;
  return carrier;
}

function materializeOtherError(spec: OtherErrorSpec): unknown {
  switch (spec.kind) {
    case 'http': {
      const carrier: any = new Error(`storage says ${spec.status}`);
      if (spec.field === 'response.status') carrier.response = { status: spec.status };
      else carrier[spec.field] = spec.status;
      return carrier;
    }
    case 'plain':
      return new Error('write failed');
    case 'nonError':
      switch (spec.value) {
        case 'string':
          return 'write failed';
        case 'number':
          return 500;
        case 'null':
          return null;
        case 'undefined':
          return undefined;
        case 'object':
          return { message: 'write failed' };
      }
      return {};
    case 'throwingGetter': {
      const carrier: any = new Error('hostile');
      for (const field of ['code', 'statusCode', 'status', 'response'] as const) {
        Object.defineProperty(carrier, field, {
          get() {
            throw new Error('hostile property access');
          },
        });
      }
      return carrier;
    }
  }
}

/** The precondition under test. `null` is covered by its own property below. */
const preconditionArb: fc.Arbitrary<UploadSavePrecondition> = fc.oneof(
  fc.constant<UploadSavePrecondition>({ ifGenerationMatch: 0 }),
  fc
    .bigInt({ min: 1n, max: 9_223_372_036_854_775_807n })
    .map<UploadSavePrecondition>((value) => ({ ifGenerationMatch: value.toString() })),
);

const tokenArb = fc.constantFrom(
  'winner-token',
  'a1b2c3d4-e5f6-4789-9abc-def012345678',
  'first-token,second-token',
  '  padded-token  ',
);

/** What the re-probe reports after the 412. */
type ReprobeSpec =
  | { kind: 'absent' }
  | { kind: 'rejects' }
  | { kind: 'found'; token: string; bytes: number; generation: string | null }
  | { kind: 'foundTokenless'; token: null | '' | '   ' };

const reprobeArb: fc.Arbitrary<ReprobeSpec> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ kind: 'absent' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'rejects' as const }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('found' as const),
      token: tokenArb,
      bytes: fc.nat({ max: 50 * 1024 * 1024 }),
      generation: fc.option(fc.constantFrom('1', '1712345678901234567'), { nil: null }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('foundTokenless' as const),
      token: fc.constantFrom<null | '' | '   '>(null, '', '   '),
    }),
  },
);

function materializeReprobe(spec: ReprobeSpec): ExistingUploadObject | null {
  if (spec.kind === 'absent' || spec.kind === 'rejects') return null;
  if (spec.kind === 'foundTokenless') {
    return { bytes: 1024, downloadToken: spec.token as any, generation: '17' };
  }
  return { bytes: spec.bytes, downloadToken: spec.token, generation: spec.generation };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RunLog {
  calls: string[];
  saveArgs: (UploadSavePrecondition | null)[];
}

/**
 * A write failure, BOXED. `null` and `undefined` are legitimate rejection values a
 * Storage layer can produce, so "no failure" has to be a distinct signal from
 * "throw this value" — an unboxed `null` would silently turn a failure case into a
 * success case and the property would assert nothing.
 */
type Failure = { value: unknown } | null;

function drive(args: {
  precondition: UploadSavePrecondition | null;
  attemptedDownloadToken: string;
  reusedProbedToken: boolean;
  firstFailure: Failure;
  secondFailure?: Failure;
  reprobe: ReprobeSpec;
}): { log: RunLog; result: Promise<UploadObjectWriteResult> } {
  const log: RunLog = { calls: [], saveArgs: [] };
  const failures: Failure[] = [args.firstFailure, args.secondFailure ?? null];
  let saveIndex = 0;

  const result = saveUploadObjectWithPrecondition({
    precondition: args.precondition,
    attemptedDownloadToken: args.attemptedDownloadToken,
    reusedProbedToken: args.reusedProbedToken,
    save: async (precondition) => {
      log.calls.push('save');
      log.saveArgs.push(precondition);
      const failure = failures[saveIndex];
      saveIndex += 1;
      if (failure) throw failure.value;
    },
    reprobe: async () => {
      log.calls.push('reprobe');
      if (args.reprobe.kind === 'rejects') throw new Error('re-probe exploded');
      return materializeReprobe(args.reprobe);
    },
  });

  return { log, result };
}

/** Shape half: the result is one of the two documented outcomes, fully populated. */
function assertWellFormed(result: UploadObjectWriteResult): void {
  if (result.outcome === 'written') {
    expect(typeof result.unconditioned).toBe('boolean');
    return;
  }
  expect(result.outcome).toBe('lost_race');
  // The url the route builds comes from this value, so it must be usable as-is.
  expect(typeof result.downloadToken).toBe('string');
  expect(result.downloadToken.length).toBeGreaterThan(0);
  expect(result.downloadToken.trim()).toBe(result.downloadToken);
  expect(typeof result.releaseReservation).toBe('boolean');
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('Property 14: A lost precondition race is a success, never an error', () => {
  it('always resolves for a 412 in any shape, whatever the re-probe reports', async () => {
    await fc.assert(
      fc.asyncProperty(
        preconditionArb,
        preconditionErrorArb,
        reprobeArb,
        tokenArb,
        fc.boolean(),
        async (precondition, errorSpec, reprobe, attemptedDownloadToken, reusedProbedToken) => {
          const error = materializePreconditionError(errorSpec);
          // Sanity: the generator really is producing 412s.
          expect(isStoragePreconditionFailed(error)).toBe(true);

          const { log, result } = drive({
            precondition,
            attemptedDownloadToken,
            reusedProbedToken,
            firstFailure: { value: error },
            reprobe,
          });

          // The invariant to protect: a 412 never becomes a rejection, which is what
          // would surface to the client as a 4xx/5xx.
          const outcome = await result;
          assertWellFormed(outcome);

          // The conditional write ran once, and the re-probe came immediately after
          // it — before any fallback write and before the route can release anything.
          expect(log.calls[0]).toBe('save');
          expect(log.calls[1]).toBe('reprobe');
          expect(log.saveArgs[0]).toEqual(precondition);
          // At most two write attempts, ever. Never a loop.
          expect(log.calls.filter((call) => call === 'save').length).toBeLessThanOrEqual(2);
          expect(log.calls.filter((call) => call === 'reprobe')).toHaveLength(1);

          const usableWinnerToken =
            reprobe.kind === 'found' ? reprobe.token.trim() : reprobe.kind === 'foundTokenless' ? '' : '';

          if (!usableWinnerToken) {
            // Vanished, tokenless or a degraded probe ⇒ today's unconditioned write,
            // exactly once, and the reservation stays with this request.
            expect(outcome).toEqual({ outcome: 'written', unconditioned: true });
            expect(log.calls).toEqual(['save', 'reprobe', 'save']);
            expect(log.saveArgs[1]).toBeNull();
            return;
          }

          const carriesOurToken = usableWinnerToken === attemptedDownloadToken.trim();
          if (carriesOurToken && !reusedProbedToken) {
            // A freshly minted token that is what is stored can only be our own
            // write, so the bytes are ours and the reservation must be kept.
            expect(outcome).toEqual({ outcome: 'written', unconditioned: false });
          } else {
            expect(outcome).toEqual({
              outcome: 'lost_race',
              downloadToken: usableWinnerToken,
              // Release only when the stored object provably is not ours.
              releaseReservation: !carriesOurToken,
            });
          }
          // A winner's bytes are already there: no second write is ever issued.
          expect(log.calls).toEqual(['save', 'reprobe']);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('never releases a reservation it cannot prove it lost', async () => {
    // The direction that matters: an over-count self-heals at the next reconcile, an
    // under-count does not. So `releaseReservation` must imply "the stored object
    // carries a token this request did not write".
    await fc.assert(
      fc.asyncProperty(
        preconditionArb,
        preconditionErrorArb,
        tokenArb,
        tokenArb,
        fc.boolean(),
        async (precondition, errorSpec, attemptedDownloadToken, winnerToken, reusedProbedToken) => {
          const { result } = drive({
            precondition,
            attemptedDownloadToken,
            reusedProbedToken,
            firstFailure: { value: materializePreconditionError(errorSpec) },
            reprobe: { kind: 'found', token: winnerToken, bytes: 4096, generation: '17' },
          });

          const outcome = await result;
          if (outcome.outcome === 'lost_race' && outcome.releaseReservation) {
            expect(outcome.downloadToken).not.toBe(attemptedDownloadToken.trim());
          }
          if (winnerToken.trim() === attemptedDownloadToken.trim()) {
            // Same token on both sides ⇒ never a release, whichever branch is taken.
            expect(outcome.outcome === 'lost_race' ? outcome.releaseReservation : false).toBe(false);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('re-throws a non-412 write failure with reference identity, and attempts no recovery', async () => {
    await fc.assert(
      fc.asyncProperty(
        preconditionArb,
        otherErrorArb,
        reprobeArb,
        tokenArb,
        async (precondition, errorSpec, reprobe, attemptedDownloadToken) => {
          const error = materializeOtherError(errorSpec);
          fc.pre(!isStoragePreconditionFailed(error));

          const { log, result } = drive({
            precondition,
            attemptedDownloadToken,
            reusedProbedToken: false,
            firstFailure: { value: error },
            reprobe,
          });

          // Identity, not equality: the route logs and classifies the original value.
          await expect(result).rejects.toBe(error);
          // No re-probe, no second write: this is a real failure, and the route's
          // rollback + `500 upload_failed` must be reached exactly as before F9.
          expect(log.calls).toEqual(['save']);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('leaves the unconditioned (legacy) path at exactly one write, even when it 412s', async () => {
    // Nothing an unconditioned write sends can produce a 412, so if one arrives it
    // is not a race signal and must not be swallowed. This is what keeps the legacy
    // path byte-for-byte identical to today: one save, and any error propagates.
    await fc.assert(
      fc.asyncProperty(preconditionErrorArb, reprobeArb, tokenArb, async (errorSpec, reprobe, token) => {
        const error = materializePreconditionError(errorSpec);
        const { log, result } = drive({
          precondition: null,
          attemptedDownloadToken: token,
          reusedProbedToken: false,
          firstFailure: { value: error },
          reprobe,
        });

        await expect(result).rejects.toBe(error);
        expect(log.calls).toEqual(['save']);
        expect(log.saveArgs).toEqual([null]);
      }),
      { numRuns: 150 }
    );
  });

  it('reports a clean unconditioned write when nothing fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(preconditionArb, { nil: null }),
        tokenArb,
        fc.boolean(),
        async (precondition, token, reusedProbedToken) => {
          const { log, result } = drive({
            precondition,
            attemptedDownloadToken: token,
            reusedProbedToken,
            firstFailure: null,
            reprobe: { kind: 'absent' },
          });

          await expect(result).resolves.toEqual({
            outcome: 'written',
            unconditioned: precondition === null,
          });
          // One write, and no extra Storage round trip on the success path.
          expect(log.calls).toEqual(['save']);
          expect(log.saveArgs).toEqual([precondition]);
        }
      ),
      { numRuns: 150 }
    );
  });
});
