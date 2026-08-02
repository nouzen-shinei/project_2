// Feature: upload-idempotency, Follow-up F9: conditional writes close the
// same-uploadKey concurrency over-count
//
// Unit coverage for the three seams F9 added to `POST /storage/upload`:
//
//   - `resolveUploadSavePrecondition` — which precondition (if any) a write carries.
//   - `isStoragePreconditionFailed`   — the 412 classifier.
//   - `saveUploadObjectWithPrecondition` — the write plus the 412 recovery.
//
// The behavior these pin (Requirements 4.1, 4.2, 9.4, 9.5, 9.9–9.13):
//
// Two attempts of one logical upload action can be in flight at once — most
// plausibly the native background uploader's internal retry firing while the first
// attempt is still connected. Both probe before either writes, so both used to see
// no existing object and both reserved the FULL file size, over-counting recorded
// usage by one file size per racing pair. A generation precondition makes "was I
// first?" atomic, lock-free and stateless: the loser gets a `412`, releases exactly
// what it reserved, and returns the WINNER's url.
//
// The invariant worth protecting above all others is that a `412` NEVER reaches the
// client as an error. An inflated usage counter is a reporting blemish that
// reconciles away; a failed upload is a broken feature. Most of the cases below
// exist to pin that.

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import {
  isStoragePreconditionFailed,
  resolveUploadSavePrecondition,
  saveUploadObjectWithPrecondition,
  UPLOAD_OBJECT_PROBE_SKIPPED,
  type ExistingUploadObject,
  type UploadObjectProbeResult,
  type UploadSavePrecondition,
} from '../app';

const existing = (over: Partial<ExistingUploadObject> = {}): ExistingUploadObject => ({
  bytes: 1024,
  downloadToken: 'stored-token',
  generation: '1712345678901234567',
  ...over,
});

// The three states a probe of a deterministic path can report (follow-up F10). Before
// F10 the resolver took `existing: ExistingUploadObject | null`, which collapsed
// "genuinely absent" and "could not be read" into one value — the bug F10 fixes.
const foundProbe = (over: Partial<ExistingUploadObject> = {}): UploadObjectProbeResult => ({
  state: 'found',
  object: existing(over),
});
const absentProbe: UploadObjectProbeResult = { state: 'absent', object: null };
const unreadableProbe: UploadObjectProbeResult = { state: 'unreadable', object: null };

/** A rejection shaped like the ones the Storage client actually produces. */
function storageError(status: number, field: 'code' | 'statusCode' | 'status' | 'response.status' = 'code'): Error {
  const error: any = new Error(`storage says ${status}`);
  if (field === 'response.status') error.response = { status };
  else error[field] = status;
  return error;
}

// ---------------------------------------------------------------------------
// resolveUploadSavePrecondition
// ---------------------------------------------------------------------------

describe('resolveUploadSavePrecondition', () => {
  it('sends create-only (ifGenerationMatch: 0) for a GENUINE 404, and only for that', () => {
    // This is the branch that closes the reported concurrency bug: two racing
    // creators cannot both succeed, so they cannot both keep a full-size
    // reservation. It must stay exactly this strong — and it must apply only where
    // the request actually observed an empty path (see the unreadable case below).
    expect(resolveUploadSavePrecondition({ keyed: true, probe: absentProbe })).toEqual({
      precondition: { ifGenerationMatch: 0 },
      reason: 'create_if_absent',
    });
  });

  it('sends NO precondition when the probe could not read the object state (F10, Req 9.13)', () => {
    // The regression F10 fixes. A non-404 metadata failure (or metadata whose
    // normalization threw) means the request observed NOTHING, so it may not assert
    // that the path is empty. It used to: `ifGenerationMatch: 0` against an object
    // that really exists 412s, the recovery re-probe then finds that object, the
    // write is attributed to a "sibling", and the caller's bytes are silently
    // dropped while the response returns the pre-existing object's url. Req 9.13
    // requires no condition and a completed upload — i.e. the pre-F9 behavior.
    expect(resolveUploadSavePrecondition({ keyed: true, probe: unreadableProbe })).toEqual({
      precondition: null,
      reason: 'probe_unreadable',
    });
  });

  it('distinguishes the two null-object states, which is the whole point of F10', () => {
    // Same `object: null` on both sides; only `state` differs, and the outcome must
    // differ with it. Pinned as one assertion so a future refactor that collapses
    // the union back into `ExistingUploadObject | null` fails here.
    const absent = resolveUploadSavePrecondition({ keyed: true, probe: absentProbe });
    const unreadable = resolveUploadSavePrecondition({ keyed: true, probe: unreadableProbe });
    expect(absentProbe.object).toBeNull();
    expect(unreadableProbe.object).toBeNull();
    expect(absent.precondition).toEqual({ ifGenerationMatch: 0 });
    expect(unreadable.precondition).toBeNull();
    expect(absent.reason).not.toBe(unreadable.reason);
  });

  it('pins the exact probed generation when overwriting, as a string', () => {
    const decision = resolveUploadSavePrecondition({
      keyed: true,
      probe: foundProbe({ generation: '9223372036854775807' }),
    });
    expect(decision).toEqual({
      precondition: { ifGenerationMatch: '9223372036854775807' },
      reason: 'match_probed_generation',
    });
    // Not a number: an int64 generation does not survive `Number()`, and a rounded
    // one would reference a version that never existed.
    expect(typeof (decision.precondition as UploadSavePrecondition).ifGenerationMatch).toBe('string');
  });

  it('degrades to NO precondition when the probe carried no usable generation', () => {
    expect(resolveUploadSavePrecondition({ keyed: true, probe: foundProbe({ generation: null }) })).toEqual({
      precondition: null,
      reason: 'generation_unavailable',
    });
  });

  it('degrades to NO precondition for a generation that is unusable even though it is a string', () => {
    // Defence in depth: the probe already normalizes, so these are unreachable from
    // the route. Re-checking here means a future caller that hand-builds an
    // `ExistingUploadObject` cannot turn an overwrite into a create-only write.
    for (const generation of ['0', '-1', '01', '1.5', '1e18', 'abc', '', '   ', '1'.repeat(25)]) {
      expect(
        resolveUploadSavePrecondition({ keyed: true, probe: foundProbe({ generation }) }).precondition
      ).toBeNull();
    }
  });

  it('never conditions an unkeyed write, whatever the probe returned', () => {
    // Legacy timestamped/random paths must stay byte-for-byte today's behavior, and
    // `profilePicture` without an `uploadKey` keeps last-writer-wins: two concurrent
    // writes there may be two genuinely different avatar picks, so handing the second
    // one the first one's url and dropping its bytes would be wrong. Only a key hash
    // certifies that the racers are attempts of ONE logical action.
    for (const probe of [absentProbe, unreadableProbe, foundProbe(), UPLOAD_OBJECT_PROBE_SKIPPED]) {
      expect(resolveUploadSavePrecondition({ keyed: false, probe })).toEqual({
        precondition: null,
        reason: 'unkeyed_path',
      });
    }
  });

  it('reports the unkeyed reason for the "no probe was performed" constant the route passes', () => {
    // A legacy path never probes at all (Req 9.7), so the route has no probe result
    // to hand over; `UPLOAD_OBJECT_PROBE_SKIPPED` stands in and `keyed: false`
    // decides before `state` is ever read.
    expect(UPLOAD_OBJECT_PROBE_SKIPPED.object).toBeNull();
    expect(resolveUploadSavePrecondition({ keyed: false, probe: UPLOAD_OBJECT_PROBE_SKIPPED }).reason).toBe(
      'unkeyed_path'
    );
  });
});

// ---------------------------------------------------------------------------
// isStoragePreconditionFailed
// ---------------------------------------------------------------------------

describe('isStoragePreconditionFailed', () => {
  it('recognizes a 412 in every location and shape the Storage client uses', () => {
    for (const field of ['code', 'statusCode', 'status', 'response.status'] as const) {
      expect(isStoragePreconditionFailed(storageError(412, field))).toBe(true);
      // Numeric strings too — some layers stringify the status.
      const asString: any = new Error('412');
      if (field === 'response.status') asString.response = { status: '412' };
      else asString[field] = '412';
      expect(isStoragePreconditionFailed(asString)).toBe(true);
    }
    // Not necessarily an Error instance.
    expect(isStoragePreconditionFailed({ code: 412 })).toBe(true);
  });

  it('does not fire for any other status, including near-misses', () => {
    for (const status of [0, 41, 404, 409, 411, 413, 4120, 500, 503]) {
      expect(isStoragePreconditionFailed(storageError(status))).toBe(false);
    }
  });

  it('is total: any non-Error rejection value is simply "not a 412"', () => {
    const throwing: any = {};
    Object.defineProperty(throwing, 'code', {
      get() {
        throw new Error('hostile property access');
      },
    });
    const hostile: unknown[] = [null, undefined, '', '412', 412, NaN, true, [], {}, Symbol('x'), 412n, throwing];
    for (const value of hostile) {
      expect(() => isStoragePreconditionFailed(value)).not.toThrow();
    }
    // A bare string/number carries nothing to read a status off, so it degrades to
    // "not a precondition failure" — which lands on the pre-existing 500 path, the
    // same outcome as before preconditions existed.
    expect(isStoragePreconditionFailed('412')).toBe(false);
    expect(isStoragePreconditionFailed(412)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveUploadObjectWithPrecondition
// ---------------------------------------------------------------------------

interface Harness {
  calls: string[];
  saveArgs: (UploadSavePrecondition | null)[];
  run: (over?: Partial<Parameters<typeof saveUploadObjectWithPrecondition>[0]>) => ReturnType<
    typeof saveUploadObjectWithPrecondition
  >;
}

/**
 * `saveFailures` is consumed one per `save()` call, so a test can make the FIRST
 * (conditional) write fail and let the second (unconditioned) one succeed.
 */
function harness(options: {
  precondition?: UploadSavePrecondition | null;
  attemptedDownloadToken?: string;
  reusedProbedToken?: boolean;
  saveFailures?: (unknown | null)[];
  reprobeResult?: ExistingUploadObject | null;
  reprobeThrows?: unknown;
}): Harness {
  const calls: string[] = [];
  const saveArgs: (UploadSavePrecondition | null)[] = [];
  const failures = [...(options.saveFailures ?? [])];

  const base = {
    precondition: options.precondition === undefined ? { ifGenerationMatch: 0 } : options.precondition,
    attemptedDownloadToken: options.attemptedDownloadToken ?? 'our-token',
    reusedProbedToken: options.reusedProbedToken ?? false,
    save: async (precondition: UploadSavePrecondition | null) => {
      calls.push(precondition ? `save:${JSON.stringify(precondition)}` : 'save:null');
      saveArgs.push(precondition);
      const failure = failures.shift();
      if (failure) throw failure;
    },
    reprobe: async () => {
      calls.push('reprobe');
      if (options.reprobeThrows) throw options.reprobeThrows;
      return options.reprobeResult ?? null;
    },
  };

  return {
    calls,
    saveArgs,
    run: (over = {}) => saveUploadObjectWithPrecondition({ ...base, ...over }),
  };
}

describe('saveUploadObjectWithPrecondition — the happy paths', () => {
  it('writes once with the precondition it was given', async () => {
    const h = harness({ precondition: { ifGenerationMatch: '77' } });

    await expect(h.run()).resolves.toEqual({ outcome: 'written', unconditioned: false });
    expect(h.saveArgs).toEqual([{ ifGenerationMatch: '77' }]);
    expect(h.calls).toEqual(['save:{"ifGenerationMatch":"77"}']);
  });

  it('writes once with no precondition on the legacy path, and never re-probes', async () => {
    const h = harness({ precondition: null });

    await expect(h.run()).resolves.toEqual({ outcome: 'written', unconditioned: true });
    expect(h.saveArgs).toEqual([null]);
    // Byte-for-byte today's behavior: one save, no extra Storage round trip.
    expect(h.calls).toEqual(['save:null']);
  });
});

describe('saveUploadObjectWithPrecondition — errors that are NOT a lost race', () => {
  it('propagates a non-412 failure untouched, so the route still rolls back and returns 500', async () => {
    const boom = storageError(500);
    const h = harness({ saveFailures: [boom] });

    await expect(h.run()).rejects.toBe(boom);
    // No recovery attempted: no re-probe, no second write.
    expect(h.calls).toEqual(['save:{"ifGenerationMatch":0}']);
  });

  it('propagates a 412 that arrives on an UNCONDITIONED write rather than inventing a race', async () => {
    // Nothing this request sent could produce a 412, so whatever this is, it is not
    // a lost race and must not be silently swallowed.
    const boom = storageError(412);
    const h = harness({ precondition: null, saveFailures: [boom] });

    await expect(h.run()).rejects.toBe(boom);
    expect(h.calls).toEqual(['save:null']);
  });
});

describe('saveUploadObjectWithPrecondition — a lost race is a SUCCESS', () => {
  it('re-probes BEFORE anything else and reports the winner token plus a release', async () => {
    const h = harness({
      saveFailures: [storageError(412)],
      reprobeResult: existing({ downloadToken: 'winner-token' }),
    });

    await expect(h.run()).resolves.toEqual({
      outcome: 'lost_race',
      downloadToken: 'winner-token',
      releaseReservation: true,
    });
    // Ordering (non-negotiable): the re-probe happens first, and no second write is
    // attempted — the loser skips a redundant multi-megabyte upload entirely.
    expect(h.calls).toEqual(['save:{"ifGenerationMatch":0}', 'reprobe']);
  });

  it('trims the winner token, so the url is built from a usable value', async () => {
    const h = harness({
      saveFailures: [storageError(412, 'response.status')],
      reprobeResult: existing({ downloadToken: '  winner-token  ' }),
    });

    await expect(h.run()).resolves.toEqual({
      outcome: 'lost_race',
      downloadToken: 'winner-token',
      releaseReservation: true,
    });
  });

  it('attributes the write to ITSELF when the stored object carries the fresh token it minted', async () => {
    // The storage client retried internally after a lost acknowledgement: our own
    // PUT landed, then the retry 412'd. A freshly minted UUID cannot have been
    // written by anyone else, so the reservation must be KEPT — releasing it would
    // under-count usage for bytes that really are stored.
    const h = harness({
      attemptedDownloadToken: 'our-token',
      reusedProbedToken: false,
      saveFailures: [storageError(412)],
      reprobeResult: existing({ downloadToken: 'our-token' }),
    });

    await expect(h.run()).resolves.toEqual({ outcome: 'written', unconditioned: false });
    expect(h.calls).toEqual(['save:{"ifGenerationMatch":0}', 'reprobe']);
  });

  it('keeps the reservation when attribution is undecidable, failing toward over-counting', async () => {
    // Both racers REUSED the token they probed, so the stored token proves nothing
    // about who wrote. Req 9.4 says degrade toward over-counting: hold the bytes and
    // let reconciliation settle it. (In practice this case reserves 0 anyway — a
    // same-size retry skips the reservation entirely.)
    const h = harness({
      attemptedDownloadToken: 'shared-token',
      reusedProbedToken: true,
      saveFailures: [storageError(412)],
      reprobeResult: existing({ downloadToken: 'shared-token' }),
    });

    await expect(h.run()).resolves.toEqual({
      outcome: 'lost_race',
      downloadToken: 'shared-token',
      releaseReservation: false,
    });
  });
});

describe('saveUploadObjectWithPrecondition — 412 then the object is gone', () => {
  it('retries ONCE with no precondition when the re-probe finds nothing', async () => {
    const h = harness({ saveFailures: [storageError(412)], reprobeResult: null });

    await expect(h.run()).resolves.toEqual({ outcome: 'written', unconditioned: true });
    expect(h.calls).toEqual(['save:{"ifGenerationMatch":0}', 'reprobe', 'save:null']);
    // Exactly today's behavior for the fallback write.
    expect(h.saveArgs[1]).toBeNull();
  });

  it('retries unconditioned when the winner carries no usable download token', async () => {
    // Without the winner's token there is no valid url to hand back — a freshly
    // minted one would not authorize against bytes we did not write — so writing our
    // own bytes is the only way to return a url that resolves.
    for (const downloadToken of [null, '', '   ']) {
      const h = harness({
        saveFailures: [storageError(412)],
        reprobeResult: existing({ downloadToken: downloadToken as any }),
      });
      await expect(h.run()).resolves.toEqual({ outcome: 'written', unconditioned: true });
      expect(h.calls).toEqual(['save:{"ifGenerationMatch":0}', 'reprobe', 'save:null']);
    }
  });

  it('treats a re-probe that rejects as "not found" instead of letting it escape', async () => {
    // `probeExistingUploadObject` is documented total, so this is unreachable from
    // the route — but the seam is injectable, and an escaped rejection here would
    // become the 500 this whole function exists to prevent.
    const h = harness({ saveFailures: [storageError(412)], reprobeThrows: new Error('probe exploded') });

    await expect(h.run()).resolves.toEqual({ outcome: 'written', unconditioned: true });
    expect(h.calls).toEqual(['save:{"ifGenerationMatch":0}', 'reprobe', 'save:null']);
  });

  it('propagates a genuine failure of the fallback write', async () => {
    const boom = storageError(503);
    const h = harness({ saveFailures: [storageError(412), boom], reprobeResult: null });

    await expect(h.run()).rejects.toBe(boom);
    // Exactly one fallback attempt — never a loop.
    expect(h.calls).toEqual(['save:{"ifGenerationMatch":0}', 'reprobe', 'save:null']);
  });

  it('does not chase a second 412 on the fallback write', async () => {
    // The fallback carries no precondition, so a 412 from it is not a race signal.
    const second = storageError(412);
    const h = harness({ saveFailures: [storageError(412), second], reprobeResult: null });

    await expect(h.run()).rejects.toBe(second);
    expect(h.calls.filter((call) => call === 'reprobe')).toHaveLength(1);
    expect(h.calls.filter((call) => call.startsWith('save:'))).toHaveLength(2);
  });
});
