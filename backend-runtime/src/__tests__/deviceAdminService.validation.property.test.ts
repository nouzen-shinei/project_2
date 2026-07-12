// Feature: device-console-migration, Property 15: Input validation rejects invalid requests with no side effects

/**
 * Property 15: Input validation rejects invalid requests with no side effects
 * Validates: Requirements 8.4, 8.8, 9.2, 10.2, 12.4, 12.6, 15.2, 15.3
 *
 * For any request field that is missing, of the wrong type, or violates its
 * bounds, the Device Admin validation helpers return `{ ok: false }` and never
 * mutate anything; for any well-formed field they return `{ ok: true }` with
 * the normalized (trimmed) value. Concretely, across generated inputs:
 *   - `validateReason`   — non-empty after trim and within 1..500 chars.
 *   - `validateExpiration` — optional; when present must parse to a time
 *     STRICTLY later than the creation time.
 *   - `validateTitle`    — non-empty after trim and within 1..100 chars.
 *   - `validateMessage`  — non-empty after trim and within 1..500 chars.
 *   - `validateTargets`  — a non-empty array (>= 1) of `{ email, deviceId }`
 *     with each field non-empty after trim, capped at 500 recipients.
 *
 * These helpers are pure functions, so "no side effects" is inherent: there is
 * no Firestore, ban, signal, or audit state to touch. The property therefore
 * asserts the stronger observable guarantees — the helpers NEVER throw and
 * ALWAYS return a well-formed `ValidationResult` object (a boolean `ok` plus
 * either a normalized `value` or a string `error`) — which is exactly what
 * lets a route reject a bad request before performing any mutation.
 *
 * The tests drive the real, exported helpers from `deviceAdminService.ts`
 * (no mocking); generators intelligently target the valid space, each bound,
 * and every rejection reason.
 */

import * as fc from 'fast-check';

import {
  validateReason,
  validateExpiration,
  validateTitle,
  validateMessage,
  validateTargets,
  DEFAULT_REASON_MAX,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_MESSAGE_MAX,
  DEFAULT_MAX_TARGETS,
  type ValidationResult,
  type DeviceTarget,
} from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Shared helpers / generators
// ---------------------------------------------------------------------------

/**
 * Assert the universal shape of a `ValidationResult`: it is always a non-null
 * object with a boolean `ok`, carrying a `value` when ok and a string `error`
 * when not. Any validator that returned anything else (or threw) fails here.
 */
function assertResultShape<T>(result: ValidationResult<T>): void {
  expect(result).not.toBeNull();
  expect(typeof result).toBe('object');
  expect(typeof result.ok).toBe('boolean');
  if (result.ok) {
    expect('value' in result).toBe(true);
  } else {
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  }
}

/** Characters that survive `String.prototype.trim()` unchanged (non-whitespace). */
const NON_WS_CHARS =
  'abcdefghijkABCDEFGHIJK0123456789!@#$%^&*()._-+=你好🙂'.split('');

/** Whitespace characters that `trim()` strips from both ends. */
const WS_CHARS = [' ', '\t', '\n', '\r', '\f', '\v', '\u00a0'];

/** A string of `min..max` non-whitespace chars (its trimmed length == its length). */
const nonWsString = (min: number, max: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...NON_WS_CHARS), { minLength: min, maxLength: max })
    .map((chars) => chars.join(''));

/** A (possibly empty) run of whitespace, used to pad valid values. */
const wsPad = (max = 5): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...WS_CHARS), { minLength: 0, maxLength: max })
    .map((chars) => chars.join(''));

/** A whitespace-only string (includes the empty string), which trims to length 0. */
const wsOnly = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...WS_CHARS), { minLength: 0, maxLength: 8 })
    .map((chars) => chars.join(''));

/** Non-string values that every text validator must reject. */
const nonStringArb = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.anything()),
  fc.object()
);

/**
 * A core token (no leading/trailing whitespace) wrapped in arbitrary
 * whitespace. Validators trim first, so the expected normalized value is the
 * bare core regardless of the padding.
 */
const paddedCore = (min: number, max: number) =>
  fc
    .tuple(wsPad(), nonWsString(min, max), wsPad())
    .map(([left, core, right]) => ({ raw: `${left}${core}${right}`, core }));

// ---------------------------------------------------------------------------
// validateReason (Requirements 8.4, 9.2, 10.2, 15.2, 15.3)
// ---------------------------------------------------------------------------

describe('Property 15 — validateReason', () => {
  it('accepts any reason that trims to 1..500 chars, returning the trimmed value (property)', () => {
    fc.assert(
      fc.property(paddedCore(1, DEFAULT_REASON_MAX), ({ raw, core }) => {
        const result = validateReason(raw);
        assertResultShape(result);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(core);
          expect(result.value.length).toBeGreaterThanOrEqual(1);
          expect(result.value.length).toBeLessThanOrEqual(DEFAULT_REASON_MAX);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('rejects empty / whitespace-only reasons with no side effects (property)', () => {
    fc.assert(
      fc.property(wsOnly(), (reason) => {
        const result = validateReason(reason);
        assertResultShape(result);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 150 }
    );
  });

  it('rejects reasons longer than 500 chars after trimming (property)', () => {
    fc.assert(
      fc.property(
        fc.tuple(wsPad(), nonWsString(DEFAULT_REASON_MAX + 1, DEFAULT_REASON_MAX + 40), wsPad()),
        ([left, core, right]) => {
          const result = validateReason(`${left}${core}${right}`);
          assertResultShape(result);
          expect(result.ok).toBe(false);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('rejects non-string reasons (property)', () => {
    fc.assert(
      fc.property(nonStringArb, (reason) => {
        const result = validateReason(reason);
        assertResultShape(result);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 150 }
    );
  });

  it('honors the exact 1 / 500 / 501 char boundaries', () => {
    expect(validateReason('a').ok).toBe(true);
    expect(validateReason('a'.repeat(DEFAULT_REASON_MAX)).ok).toBe(true);
    expect(validateReason('a'.repeat(DEFAULT_REASON_MAX + 1)).ok).toBe(false);
    expect(validateReason('').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateExpiration (Requirement 8.8)
// ---------------------------------------------------------------------------

// A broad but safely-finite epoch-ms range so `createdAt + delta` never
// overflows into non-finite territory: ~1970-01-01 .. ~2100-01-01.
const createdAtArb = fc.integer({ min: 0, max: 4_102_444_800_000 });

describe('Property 15 — validateExpiration', () => {
  it('treats null / undefined as "no expiration" → ok(null) (property)', () => {
    fc.assert(
      fc.property(createdAtArb, fc.constantFrom(null, undefined), (createdAtMs, expiresAt) => {
        const result = validateExpiration(expiresAt, createdAtMs);
        assertResultShape(result);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeNull();
        }
      }),
      { numRuns: 120 }
    );
  });

  it('accepts an epoch-ms strictly later than creation, returning that value (property)', () => {
    fc.assert(
      fc.property(createdAtArb, fc.integer({ min: 1, max: 5_000_000_000 }), (createdAtMs, delta) => {
        const expiresAt = createdAtMs + delta;
        const result = validateExpiration(expiresAt, createdAtMs);
        assertResultShape(result);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(expiresAt);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('accepts an ISO datetime strictly later than creation (property)', () => {
    fc.assert(
      fc.property(createdAtArb, fc.integer({ min: 1, max: 5_000_000_000 }), (createdAtMs, delta) => {
        const expiresMs = createdAtMs + delta;
        const iso = new Date(expiresMs).toISOString();
        const result = validateExpiration(iso, createdAtMs);
        assertResultShape(result);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // ISO 8601 round-trips at ms precision, so the parsed value is exact.
          expect(result.value).toBe(expiresMs);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('rejects an expiration at or before creation (delta <= 0), for numbers and ISO strings (property)', () => {
    fc.assert(
      fc.property(createdAtArb, fc.integer({ min: 0, max: 5_000_000_000 }), (createdAtMs, delta) => {
        const expiresMs = createdAtMs - delta; // delta 0 => equal (still invalid)
        const numResult = validateExpiration(expiresMs, createdAtMs);
        assertResultShape(numResult);
        expect(numResult.ok).toBe(false);

        const isoResult = validateExpiration(new Date(expiresMs).toISOString(), createdAtMs);
        assertResultShape(isoResult);
        expect(isoResult.ok).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('rejects unparseable / wrong-type expirations without throwing (property)', () => {
    const badExpirations = fc.oneof(
      fc.constant('not-a-timestamp'),
      fc.constant(''),
      fc.constant('   '),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.boolean(),
      fc.object(),
      fc.array(fc.anything())
    );
    fc.assert(
      fc.property(createdAtArb, badExpirations, (createdAtMs, expiresAt) => {
        const result = validateExpiration(expiresAt, createdAtMs);
        assertResultShape(result);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 150 }
    );
  });

  it('honors the exact creation-time boundary (equal is rejected, +1ms is accepted)', () => {
    const created = 1_700_000_000_000;
    expect(validateExpiration(created, created).ok).toBe(false);
    expect(validateExpiration(created - 1, created).ok).toBe(false);
    const later = validateExpiration(created + 1, created);
    expect(later.ok).toBe(true);
    if (later.ok) {
      expect(later.value).toBe(created + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// validateTitle (Requirements 12.4 support) & validateMessage (Requirement 12.4)
// ---------------------------------------------------------------------------

describe('Property 15 — validateTitle', () => {
  it('accepts titles that trim to 1..100 chars, returning the trimmed value (property)', () => {
    fc.assert(
      fc.property(paddedCore(1, NOTIFICATION_TITLE_MAX), ({ raw, core }) => {
        const result = validateTitle(raw);
        assertResultShape(result);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(core);
          expect(result.value.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('rejects empty/whitespace-only, over-100, and non-string titles (property)', () => {
    const invalidTitle = fc.oneof(
      wsOnly(),
      nonWsString(NOTIFICATION_TITLE_MAX + 1, NOTIFICATION_TITLE_MAX + 30),
      nonStringArb
    );
    fc.assert(
      fc.property(invalidTitle, (title) => {
        const result = validateTitle(title);
        assertResultShape(result);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('honors the exact 100 / 101 char boundary', () => {
    expect(validateTitle('t'.repeat(NOTIFICATION_TITLE_MAX)).ok).toBe(true);
    expect(validateTitle('t'.repeat(NOTIFICATION_TITLE_MAX + 1)).ok).toBe(false);
  });
});

describe('Property 15 — validateMessage', () => {
  it('accepts messages that trim to 1..500 chars, returning the trimmed value (property)', () => {
    fc.assert(
      fc.property(paddedCore(1, NOTIFICATION_MESSAGE_MAX), ({ raw, core }) => {
        const result = validateMessage(raw);
        assertResultShape(result);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(core);
          expect(result.value.length).toBeLessThanOrEqual(NOTIFICATION_MESSAGE_MAX);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('rejects empty/whitespace-only, over-500, and non-string messages (property)', () => {
    const invalidMessage = fc.oneof(
      wsOnly(),
      nonWsString(NOTIFICATION_MESSAGE_MAX + 1, NOTIFICATION_MESSAGE_MAX + 30),
      nonStringArb
    );
    fc.assert(
      fc.property(invalidMessage, (message) => {
        const result = validateMessage(message);
        assertResultShape(result);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('honors the exact 500 / 501 char boundary', () => {
    expect(validateMessage('m'.repeat(NOTIFICATION_MESSAGE_MAX)).ok).toBe(true);
    expect(validateMessage('m'.repeat(NOTIFICATION_MESSAGE_MAX + 1)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateTargets (Requirements 12.6, 14.2)
// ---------------------------------------------------------------------------

/** A valid target whose email/deviceId are padded with whitespace to test trimming. */
const paddedTargetArb = fc.record({
  email: paddedCore(1, 12),
  deviceId: paddedCore(1, 12),
});

describe('Property 15 — validateTargets', () => {
  it('accepts a non-empty, <=500 list, returning trimmed targets in order (property)', () => {
    fc.assert(
      fc.property(fc.array(paddedTargetArb, { minLength: 1, maxLength: 15 }), (entries) => {
        const raw = entries.map((t) => ({ email: t.email.raw, deviceId: t.deviceId.raw }));
        const expected: DeviceTarget[] = entries.map((t) => ({
          email: t.email.core,
          deviceId: t.deviceId.core,
        }));
        const result = validateTargets(raw);
        assertResultShape(result);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual(expected);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('rejects an empty target list (property)', () => {
    fc.assert(
      fc.property(fc.constant([]), (targets) => {
        const result = validateTargets(targets);
        assertResultShape(result);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects a list exceeding the 500-recipient cap (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: DEFAULT_MAX_TARGETS + 1, max: DEFAULT_MAX_TARGETS + 60 }), (n) => {
        const oversized = Array.from({ length: n }, (_unused, i) => ({
          email: `user${i}@example.com`,
          deviceId: `device-${i}`,
        }));
        const result = validateTargets(oversized);
        assertResultShape(result);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects a list containing any malformed entry (property)', () => {
    const badEntryArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.string(),
      fc.record({ deviceId: nonWsString(1, 5) }), // missing email
      fc.record({ email: nonWsString(1, 5) }), // missing deviceId
      fc.record({ email: fc.constant(''), deviceId: nonWsString(1, 5) }), // empty email
      fc.record({ email: nonWsString(1, 5), deviceId: fc.constant('   ') }) // whitespace deviceId
    );
    fc.assert(
      fc.property(
        fc.array(paddedTargetArb, { minLength: 0, maxLength: 5 }),
        badEntryArb,
        fc.nat(),
        (goodEntries, bad, insertAt) => {
          const good = goodEntries.map((t) => ({
            email: t.email.raw,
            deviceId: t.deviceId.raw,
          }));
          const index = good.length === 0 ? 0 : insertAt % (good.length + 1);
          const list: unknown[] = [...good];
          list.splice(index, 0, bad);
          const result = validateTargets(list);
          assertResultShape(result);
          expect(result.ok).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('rejects a non-array targets value (property)', () => {
    const nonArray = fc.oneof(
      fc.integer(),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.object()
    );
    fc.assert(
      fc.property(nonArray, (targets) => {
        const result = validateTargets(targets);
        assertResultShape(result);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 150 }
    );
  });

  it('honors the exact 1 / 500 / 501 recipient boundaries', () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_unused, i) => ({ email: `u${i}@x.io`, deviceId: `d${i}` }));
    expect(validateTargets(make(1)).ok).toBe(true);
    expect(validateTargets(make(DEFAULT_MAX_TARGETS)).ok).toBe(true);
    expect(validateTargets(make(DEFAULT_MAX_TARGETS + 1)).ok).toBe(false);
    expect(validateTargets([]).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Universal purity: never throw, always return a well-formed result
// ---------------------------------------------------------------------------

describe('Property 15 — validators never throw and always return a result object', () => {
  it('every validator returns a well-formed ValidationResult for arbitrary input (property)', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (arbitrary, createdAtCandidate) => {
        const createdAtMs =
          typeof createdAtCandidate === 'number' ? createdAtCandidate : 0;

        // None of these may throw; each must return a well-formed result object.
        assertResultShape(validateReason(arbitrary));
        assertResultShape(validateExpiration(arbitrary, createdAtMs));
        assertResultShape(validateTitle(arbitrary));
        assertResultShape(validateMessage(arbitrary));
        assertResultShape(validateTargets(arbitrary));
      }),
      { numRuns: 300 }
    );
  });
});
