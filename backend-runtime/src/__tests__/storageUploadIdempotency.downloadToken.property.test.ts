// Feature: upload-idempotency, Property 12: The returned download URL is stable across retries, and its token comes from the stored object — for any uploadKey, purpose, filename and existing-object metadata the url returned for a second request carrying that same uploadKey is byte-identical to the first successful write's url; the reused token is read from the stored object's firebaseStorageDownloadTokens and is never a function of the client-supplied uploadKey; and when the probe returns null (or an object carrying no token) the token is freshly generated, so two independent runs with the same uploadKey yield different tokens.
/**
 * Property 12 (upload-idempotency, task 5.2).
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
 *
 * Drives the REAL exported seam from `app.ts` — `selectUploadDownloadToken`,
 * `buildUploadDownloadUrl` and (for the metadata-normalization direction) the real
 * `probeExistingUploadObject` against a stubbed bucket handle. No live Storage, no
 * live Firestore, no mocking of the functions under test. Every property runs at
 * least 100 fast-check iterations.
 *
 * The two attempts of a retry are modelled EXPLICITLY, end to end, through the same
 * composition the route performs (`deriveUploadKeyHash` → `resolveUploadObjectPath`
 * → `selectUploadDownloadToken` → `buildUploadDownloadUrl`):
 *
 *   attempt 1 — nothing stored yet ⇒ probe result `null` ⇒ a fresh token;
 *   attempt 2 — the probe finds attempt 1's object and its token ⇒ that token is reused.
 *
 * Composing the whole chain matters: url stability is a property of the token AND
 * the path together, so a test that only compared two `selectUploadDownloadToken`
 * calls would not actually pin Requirement 4.2. Each attempt re-derives the path
 * with its own injected clock and random suffix, exactly as a real retry would.
 *
 * ---------------------------------------------------------------------------
 * Why (c) asserts TOKEN invariance and deliberately NOT `url` invariance
 * ---------------------------------------------------------------------------
 * Requirement 4.4 says the token must not be a function of any client-supplied
 * value. The natural-looking generalization — "varying the `uploadKey` must not
 * change the `url`" — is FALSE by design: the url embeds the object path, and the
 * path is keyed on the `uploadKey` (that is Property 2, Requirement 1.4). Asserting
 * url invariance here would produce a failing test whose "fix" would decouple the
 * path from the `uploadKey` and defeat the entire feature. So the independence
 * direction below holds the stored object fixed, varies every client-controlled
 * input, and asserts the selected TOKEN is unchanged — while separately asserting
 * that distinct keys DO yield distinct paths and therefore distinct urls.
 *
 * ---------------------------------------------------------------------------
 * Leak threshold, why it is 8 characters, and why it applies only to minting
 * ---------------------------------------------------------------------------
 * Leak-freedom is asserted on the MINT branch only. On the reuse branch the token is
 * the stored value byte for byte — asserted directly — so there is nothing to leak
 * into, and comparing it against the client's key only measures how much the two
 * generators' pools overlap.
 *
 * A freshly minted token is a UUID (or 32 hex characters), so only substrings of a
 * client value that are themselves hex-ish can appear in it at all, and short ones
 * appear by pure coincidence: an 'a'-run of length 1 turns up in a random 20-hex
 * digest ~72% of the time. The endpoint's schema already rejects an `uploadKey`
 * shorter than 8 characters (`z.string().trim().min(8)`, Req 6.8), so 8 is both the
 * shortest key the feature ever sees in production and a length whose coincidental
 * appearance is ~1e-8. Checking runs of exactly this length covers every longer run
 * too: a 12-character leak necessarily contains its own first 8 characters.
 *
 * ---------------------------------------------------------------------------
 * Input-space notes (deliberate exclusions, with reasons)
 * ---------------------------------------------------------------------------
 * - `selectUploadDownloadToken`'s totality is asserted over `null`, `undefined`,
 *   arbitrary values and hand-built objects carrying a non-string `downloadToken`.
 *   Objects whose property READ itself throws are excluded: the sole producer of
 *   this argument is `probeExistingUploadObject`, which returns `null` or a plain
 *   object literal with both fields already normalized, so a throwing getter is
 *   unreachable here. Probe-side hostility is Property 13's job (task 5.3).
 * - Raw object paths generated for the url builder are well-formed Unicode. A lone
 *   surrogate would make `encodeURIComponent` throw, but a path always comes from
 *   `resolveUploadObjectPath`, which reduces every variable segment to
 *   `[A-Za-z0-9._-]`, so an unpaired surrogate cannot reach the builder.
 */

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import * as fc from 'fast-check';

import {
  selectUploadDownloadToken,
  buildUploadDownloadUrl,
  probeExistingUploadObject,
  type ExistingUploadObject,
} from '../app';
import {
  deriveUploadKeyHash,
  resolveUploadObjectPath,
  type StorageUploadPurpose,
} from '../lib/uploadObjectPath';

const NUM_RUNS = 200;

/** Minimum client-value substring length treated as evidence of a leak (see header). */
const MIN_LEAK_SUBSTRING = 8;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const PURPOSES: readonly StorageUploadPurpose[] = [
  'chat',
  'tenantLogo',
  'noticeImage',
  'noticeAudio',
  'studentProfile',
  'receipt',
  'profilePicture',
];

const purposeArb = fc.constantFrom(...PURPOSES);

/** Server-derived (`req.tenantAccess.tenantId`, `req.authContext.uid`) — never client input. */
const tenantIdArb = fc.constantFrom('acme', 'tenant_1', 'T-42', 'x', 'tenant.co');
const actorUidArb = fc.constantFrom('uid_123', 'staff-9', 'A'.repeat(28));
const bucketNameArb = fc.constantFrom(
  'proj.appspot.com',
  'proj-42.firebasestorage.app',
  'bucket-x',
);

/**
 * Filenames that exercise sanitization: spaces, Unicode, `+`, `%`, `&`, `?`, `#`,
 * dot runs, no extension, hidden files, and a very long name.
 */
const FILENAMES = [
  'march.pdf',
  'photo.jpg',
  'my report final.pdf',
  'facture reçu.pdf',
  'ファイル.png',
  'a+b&c?d#e%f.png',
  'no-extension',
  '.hidden',
  'report..v2.pdf',
  'party 🎉.png',
  '../../etc/passwd',
  `${'x'.repeat(300)}.jpg`,
] as const;

const filenameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...FILENAMES) },
  { weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 40 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 }) },
);

const UPLOAD_KEYS = [
  'receipt_1717171717171_abc123',
  '4f8d1c2e-9a3b-4c5d-8e7f-0a1b2c3d4e5f',
  'tempId_1717171717171_9f2c',
  'aaaaaaaa',
  '0123456789abcdef0123',
  'deadbeefdeadbeef',
  '  padded-upload-key-0001  ',
  'ключ-загрузки-0001',
  'emoji-key-🎉-0001',
  'k'.repeat(200),
] as const;

/** Non-blank keys of at least the endpoint's accepted length (Req 6.8). */
const uploadKeyArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...UPLOAD_KEYS) },
  {
    weight: 3,
    arbitrary: fc.string({ minLength: 8, maxLength: 60 }).filter((k) => k.trim().length >= 8),
  },
  {
    weight: 2,
    arbitrary: fc
      .string({ unit: 'grapheme', minLength: 8, maxLength: 40 })
      .filter((k) => k.trim().length >= 8),
  },
);

const contentTypeArb = fc.constantFrom<string | null>(
  'image/png',
  'image/jpeg',
  'application/pdf',
  'audio/mp4',
  'video/mp4',
  'application/octet-stream',
  null,
);

const conversationFolderArb = fc.constantFrom(
  'c_0123456789',
  'alice@example.com_bob@example.com',
  'unassigned',
  '../escape',
);

const feeIdArb = fc.constantFrom('fee_77', 'FEE-2024-01', '../../other-tenant', 'f');

/** Always non-blank, so `profilePicture` always resolves (Req 1.5). */
const emailArb = fc.constantFrom(
  'user@example.com',
  'USER@Example.COM',
  ' spaced.user@example.com ',
  'staff+tag@example.co.uk',
);

/** Injected clock + random suffix; a deterministic path must ignore both. */
interface Clock {
  now: number;
  randomSuffix: string;
}

const clockArb: fc.Arbitrary<Clock> = fc.record({
  now: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  randomSuffix: fc.constantFrom('aabbcc', '000000', 'ff00aa', 'deadbe'),
});

/** Everything the CLIENT supplies about the file. Varied wholesale in the independence property. */
interface ClientInput {
  uploadKey: string;
  filename: string;
  contentType: string | null;
  conversationFolder: string;
  feeId: string;
  email: string;
}

const clientInputArb: fc.Arbitrary<ClientInput> = fc.record({
  uploadKey: uploadKeyArb,
  filename: filenameArb,
  contentType: contentTypeArb,
  conversationFolder: conversationFolderArb,
  feeId: feeIdArb,
  email: emailArb,
});

/** Everything the SERVER derives about the request. Held fixed across a retry. */
interface RequestScope {
  purpose: StorageUploadPurpose;
  tenantId: string;
  actorUid: string;
  bucketName: string;
}

const requestScopeArb: fc.Arbitrary<RequestScope> = fc.record({
  purpose: purposeArb,
  tenantId: tenantIdArb,
  actorUid: actorUidArb,
  bucketName: bucketNameArb,
});

/** Non-blank, trim-invariant, comma-free token values a stored object can carry. */
const storedTokenArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'abc-123',
      '9f2c41e0-7f3a-4d21-9c5e-1b8a0c6d5e42',
      '0123456789abcdef',
      'T'.repeat(64),
    ),
  },
  {
    weight: 2,
    arbitrary: fc
      .string({ minLength: 1, maxLength: 40 })
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.includes(',')),
  },
);

/** Every shape that must send `selectUploadDownloadToken` down its mint branch (Req 4.3). */
const mintTriggerArb: fc.Arbitrary<ExistingUploadObject | null> = fc.oneof(
  fc.constant(null),
  fc.record({ bytes: fc.nat(), downloadToken: fc.constant(null) }),
  fc.record({ bytes: fc.nat(), downloadToken: fc.constantFrom('', ' ', '   ', '\t\n') }),
  fc.record({
    bytes: fc.nat(),
    downloadToken: fc.constantFrom<any>(42, {}, [], true, undefined),
  }),
) as fc.Arbitrary<ExistingUploadObject | null>;

/**
 * Object paths for the url builder, exercising percent-encoding: slashes, spaces,
 * Unicode, `+`, `%`, `&`, `?`, `#`, emoji and a very long name.
 */
const RAW_PATHS = [
  'receipts/acme/fee_77/k_0123456789abcdef0123_march.pdf',
  'chat-files/acme/c_0123456789/k_0123456789abcdef0123_photo.jpg',
  'notices/acme/audio/notice_audio_k_0123456789abcdef0123.m4a',
  'a b/c d/e f.png',
  'files/ünïcode/ファイル.png',
  'files/plus+name/a+b.png',
  'files/pct%20name/50%.pdf',
  'files/amp&q?x#frag/name.pdf',
  'files/emoji-🎉/party 🎉.png',
  `files/${'long'.repeat(200)}/name.bin`,
] as const;

const rawObjectPathArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...RAW_PATHS) },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }), {
        minLength: 1,
        maxLength: 4,
      })
      .map((parts) => parts.join('/')),
  },
);

/** Malformed `existing` shapes for the totality property (throwing getters excluded — see header). */
const hostileExistingArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 3, arbitrary: fc.anything() },
  {
    weight: 3,
    arbitrary: fc.record({ bytes: fc.anything(), downloadToken: fc.anything() }),
  },
);

// ---------------------------------------------------------------------------
// The composition under test: one upload attempt, end to end
// ---------------------------------------------------------------------------

interface AttemptOutcome {
  objectPath: string;
  downloadToken: string;
  url: string;
}

/**
 * One attempt of the route's derive → probe-result → select-token → build-url chain.
 * `existing` is what the probe of the deterministic path returned for THIS attempt.
 */
function runAttempt(
  scope: RequestScope,
  client: ClientInput,
  existing: ExistingUploadObject | null,
  clock: Clock,
): AttemptOutcome {
  const uploadKeyHash = deriveUploadKeyHash({
    uploadKey: client.uploadKey,
    tenantId: scope.tenantId,
    purpose: scope.purpose,
    actorUid: scope.actorUid,
  });
  const resolved = resolveUploadObjectPath({
    purpose: scope.purpose,
    tenantId: scope.tenantId,
    filename: client.filename,
    contentType: client.contentType,
    conversationFolder: client.conversationFolder,
    feeId: client.feeId,
    email: client.email,
    uploadKeyHash,
    now: clock.now,
    randomSuffix: clock.randomSuffix,
  });
  if (!resolved.ok) {
    // The generators always supply every required input, so this is a generator
    // defect rather than a property failure — surface it loudly.
    throw new Error(`generator produced an unresolvable input: ${resolved.error}`);
  }
  const downloadToken = selectUploadDownloadToken(existing);
  return {
    objectPath: resolved.objectPath,
    downloadToken,
    url: buildUploadDownloadUrl(scope.bucketName, resolved.objectPath, downloadToken),
  };
}

/** A bucket handle whose `file()` records every method invoked on it. */
function stubBucket(metadata: unknown) {
  const calls: string[] = [];
  return {
    calls,
    name: 'stub-bucket',
    file(objectPath: string) {
      calls.push(`file:${objectPath}`);
      return {
        async getMetadata() {
          calls.push('getMetadata');
          return [metadata, {}];
        },
        async save() {
          calls.push('save');
          throw new Error('the probe must never write');
        },
        async setMetadata() {
          calls.push('setMetadata');
          throw new Error('the probe must never mutate');
        },
        async delete() {
          calls.push('delete');
          throw new Error('the probe must never delete');
        },
      };
    },
  };
}

/** Every substring of `value` of exactly `length` characters. */
function substringsOfLength(value: string, length: number): string[] {
  if (value.length < length) return [];
  const out: string[] = [];
  for (let i = 0; i + length <= value.length; i += 1) out.push(value.slice(i, i + length));
  return out;
}

/** No meaningful run of a client-supplied value survives into the token (Req 4.4). */
function assertNoClientValueLeak(token: string, clientValue: string): void {
  const trimmed = clientValue.trim();
  if (trimmed.length >= MIN_LEAK_SUBSTRING) {
    expect(token).not.toBe(trimmed);
    expect(token.includes(trimmed)).toBe(false);
  }
  for (const candidate of substringsOfLength(trimmed.slice(0, 512), MIN_LEAK_SUBSTRING)) {
    expect(token.includes(candidate)).toBe(false);
  }
}

const URL_PREFIX = 'https://firebasestorage.googleapis.com/v0/b/';

/** The url is well-formed, carries the token verbatim, and round-trips the path exactly. */
function assertWellFormedUrl(
  url: string,
  bucketName: string,
  objectPath: string,
  token: string,
): void {
  const prefix = `${URL_PREFIX}${bucketName}/o/`;
  expect(url.startsWith(prefix)).toBe(true);

  const rest = url.slice(prefix.length);
  const queryStart = rest.indexOf('?');
  expect(queryStart).toBeGreaterThan(0);

  const encodedPath = rest.slice(0, queryStart);
  expect(rest.slice(queryStart)).toBe(`?alt=media&token=${token}`);
  // Percent-encoding is lossless: Firebase resolves the object by the decoded name.
  expect(decodeURIComponent(encodedPath)).toBe(objectPath);
  // Nothing that would split the url or the path survived unencoded.
  for (const raw of ['/', ' ', '?', '#', '&', '+']) {
    expect(encodedPath.includes(raw)).toBe(false);
  }
}

// ---------------------------------------------------------------------------

describe('Property 12: The returned download URL is stable across retries, and its token comes from the stored object', () => {
  describe('(a) url stability across a retry (Requirements 4.1, 4.2)', () => {
    it('returns a byte-identical url for every subsequent attempt carrying the same uploadKey', () => {
      fc.assert(
        fc.property(
          requestScopeArb,
          clientInputArb,
          // Attempt 1 plus 1..4 retries, each with its own clock/random suffix.
          fc.array(clockArb, { minLength: 2, maxLength: 5 }),
          fc.nat({ max: 5_000_000 }),
          (scope, client, clocks, storedBytes) => {
            // Attempt 1: nothing stored yet ⇒ the probe result is null ⇒ fresh token.
            const first = runAttempt(scope, client, null, clocks[0]);
            expect(first.downloadToken.length).toBeGreaterThan(0);
            assertWellFormedUrl(first.url, scope.bucketName, first.objectPath, first.downloadToken);

            const firstUrlBytes = Buffer.from(first.url, 'utf8');

            // Attempts 2..N: the probe finds the object the previous attempt wrote.
            let previous = first;
            for (const clock of clocks.slice(1)) {
              const existing: ExistingUploadObject = {
                bytes: storedBytes,
                downloadToken: previous.downloadToken,
                // Token selection does not read `generation` (F9 added it for the
                // write precondition); `null` keeps this attempt on the same
                // last-writer-wins write the pre-F9 route performed.
                generation: null,
              };
              const retry = runAttempt(scope, client, existing, clock);

              // The path is re-derived from scratch with a different clock and a
              // different random suffix, and still lands on the same object.
              expect(retry.objectPath).toBe(first.objectPath);
              // The stored token is reused verbatim (Req 4.1)…
              expect(retry.downloadToken).toBe(first.downloadToken);
              // …so the url is byte-identical to the first write's (Req 4.2).
              expect(retry.url).toBe(first.url);
              expect(Buffer.from(retry.url, 'utf8').equals(firstUrlBytes)).toBe(true);
              assertWellFormedUrl(retry.url, scope.bucketName, retry.objectPath, retry.downloadToken);

              previous = retry;
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('(b) the token is the FIRST token read off the stored object (Requirement 4.1)', () => {
    it('reuses the first metadata token, so a multi-token object still yields the first attempt url', async () => {
      await fc.assert(
        fc.asyncProperty(
          requestScopeArb,
          clientInputArb,
          clockArb,
          clockArb,
          // Extra tokens someone else may have appended to the metadata list.
          fc.array(storedTokenArb, { maxLength: 3 }),
          fc.constantFrom<unknown>(2048, '2048', undefined),
          async (scope, client, clock1, clock2, extraTokens, rawSize) => {
            const first = runAttempt(scope, client, null, clock1);

            // The stored object as Storage actually reports it: a comma-joined
            // `firebaseStorageDownloadTokens` whose FIRST entry is what attempt 1 wrote.
            const bucket = stubBucket({
              size: rawSize,
              metadata: {
                firebaseStorageDownloadTokens: [first.downloadToken, ...extraTokens].join(','),
              },
            });

            const probed = await probeExistingUploadObject(bucket as any, first.objectPath, scope.purpose);
            expect(probed).not.toBeNull();
            expect(probed!.downloadToken).toBe(first.downloadToken);

            const retry = runAttempt(scope, client, probed, clock2);
            expect(retry.downloadToken).toBe(first.downloadToken);
            expect(retry.url).toBe(first.url);

            // Read-only: exhaustive probe hostility is Property 13 (task 5.3); this
            // single guard just pins that reading the token never touched the object.
            expect(bucket.calls).toContain('getMetadata');
            for (const mutator of ['save', 'setMetadata', 'delete']) {
              expect(bucket.calls).not.toContain(mutator);
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('(c) the token is independent of every client-supplied value (Requirement 4.4)', () => {
    it('selects the same token when the client varies uploadKey, filename and every other input', () => {
      fc.assert(
        fc.property(
          requestScopeArb,
          clientInputArb,
          clientInputArb,
          storedTokenArb,
          clockArb,
          clockArb,
          (scope, clientA, clientB, storedToken, clock1, clock2) => {
            // ONE stored object, held fixed, probed by two requests whose client
            // inputs differ in every field.
            const stored: ExistingUploadObject = { bytes: 4096, downloadToken: storedToken, generation: '42' };

            const a = runAttempt(scope, clientA, stored, clock1);
            const b = runAttempt(scope, clientB, stored, clock2);

            // The token is a function of the STORED OBJECT's metadata alone.
            expect(a.downloadToken).toBe(storedToken);
            expect(b.downloadToken).toBe(a.downloadToken);
            // Visible in the url too: same `token=` regardless of the client input.
            expect(a.url.endsWith(`?alt=media&token=${storedToken}`)).toBe(true);
            expect(b.url.endsWith(`?alt=media&token=${storedToken}`)).toBe(true);

            // NOT asserted here: leak-freedom. On the REUSE branch the token IS the
            // stored value, byte for byte — which the assertion above pins exactly —
            // so "the token shares no run with the client's key" is not a claim about
            // this branch at all: it is a claim about how the token was MINTED, and it
            // is asserted in (d) where minting happens. Asserting it here just makes
            // the two generators' pools collide; an earlier version of this test did,
            // and fast-check duly found stored token `0123456789abcdef` against
            // uploadKey `0123456789abcdef0123` — two hex-shaped values drawn from
            // overlapping pools, not a leak.
            //
            // NOT asserted either: url invariance. A different `uploadKey` legitimately
            // yields a different object path (Property 2, Req 1.4) and therefore a
            // different url — which is what the next two assertions pin instead.
            if (
              scope.purpose !== 'profilePicture' &&
              clientA.uploadKey.trim() !== clientB.uploadKey.trim()
            ) {
              expect(b.objectPath).not.toBe(a.objectPath);
              expect(b.url).not.toBe(a.url);
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('selects the stored token even when it arrives whitespace-padded', () => {
      fc.assert(
        fc.property(
          storedTokenArb,
          fc.constantFrom('', ' ', '   ', '\t', '\n', '\r\n'),
          fc.constantFrom('', ' ', '  ', '\t\n'),
          fc.nat(),
          (token, left, right, bytes) => {
            const selected = selectUploadDownloadToken({
              bytes,
              downloadToken: `${left}${token}${right}`,
            });
            expect(selected).toBe(token);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('(d) freshness and non-leakage on the mint branch (Requirement 4.3)', () => {
    it('mints a different token for each run with no usable stored token, leaking no client value', () => {
      fc.assert(
        fc.property(
          requestScopeArb,
          clientInputArb,
          mintTriggerArb,
          clockArb,
          clockArb,
          (scope, client, trigger, clock1, clock2) => {
            // Same client input, same (unusable) probe result, two independent runs.
            const a = runAttempt(scope, client, trigger, clock1);
            const b = runAttempt(scope, client, trigger, clock2);

            for (const outcome of [a, b]) {
              expect(typeof outcome.downloadToken).toBe('string');
              expect(outcome.downloadToken.length).toBeGreaterThan(0);
              // A minted token is never blank and never needs trimming.
              expect(outcome.downloadToken.trim()).toBe(outcome.downloadToken);
              assertWellFormedUrl(
                outcome.url,
                scope.bucketName,
                outcome.objectPath,
                outcome.downloadToken,
              );
              // The capability token is not steerable by client input.
              assertNoClientValueLeak(outcome.downloadToken, client.uploadKey);
              assertNoClientValueLeak(outcome.downloadToken, client.filename);
            }

            // Freshness: successive mints differ, so the same path gets a new token.
            expect(b.downloadToken).not.toBe(a.downloadToken);
            expect(a.objectPath).toBe(b.objectPath);
            expect(b.url).not.toBe(a.url);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('totality of the seam', () => {
    it('selectUploadDownloadToken never throws and always returns a non-empty token', () => {
      fc.assert(
        fc.property(hostileExistingArb, (value) => {
          let token = '';
          expect(() => {
            token = selectUploadDownloadToken(value as ExistingUploadObject | null);
          }).not.toThrow();
          expect(typeof token).toBe('string');
          expect(token.trim().length).toBeGreaterThan(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('buildUploadDownloadUrl round-trips any object path through percent-encoding', () => {
      fc.assert(
        fc.property(bucketNameArb, rawObjectPathArb, storedTokenArb, (bucketName, objectPath, token) => {
          const url = buildUploadDownloadUrl(bucketName, objectPath, token);
          assertWellFormedUrl(url, bucketName, objectPath, token);
          // Deterministic: the same inputs always produce the same string.
          expect(buildUploadDownloadUrl(bucketName, objectPath, token)).toBe(url);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
