// Feature: upload-idempotency, Property 13: The existing-object probe is total
/**
 * Property 13: The existing-object probe is total
 *
 * For any value a metadata read can reject with — an `Error` with or without a 404
 * `code`/`statusCode`, a non-`Error` throwable (string, number, `null`, `undefined`,
 * an object with a throwing getter) — and for any malformed metadata shape it can
 * resolve with (`size` absent, a string, negative or `NaN`;
 * `firebaseStorageDownloadTokens` absent, empty, a comma-joined list or a
 * non-string), `probeExistingUploadObject` resolves to either `null` or a well-formed
 * `ExistingUploadObject` (finite non-negative `bytes`; `downloadToken` a non-empty
 * string or `null`). It never throws, never writes, and never mutates the probed
 * object. Non-404 failures increment the probe-failure counter exactly once; 404s and
 * successes increment it zero times.
 *
 * **Validates: Requirements 8.2, 9.1, 9.2, 9.3**
 *
 * ---------------------------------------------------------------------------
 * Extended for the `generation` field (upload-idempotency follow-up F9)
 * ---------------------------------------------------------------------------
 * The probe now also carries the object's Storage `generation`, which the write
 * sends back as `ifGenerationMatch`. That raises the stakes on normalization: a
 * generation is an int64 serialized as a STRING, so a coerced one would reference a
 * version that never existed, and a bogus `0` would flip the precondition from
 * "overwrite exactly this version" to "the object must not exist" and 412 forever.
 * The metadata generator therefore includes 19- and 20-digit values, `'0'`, leading
 * zeros, signs, floats, exponent notation, hex, bigints, non-strings and a throwing
 * getter, and the well-formedness assertion pins that whatever survives is a real
 * decimal generation that round-trips through `BigInt` unchanged — or `null`, which
 * means "send no precondition", i.e. today's last-writer-wins.
 *
 * ---------------------------------------------------------------------------
 * Extended for the three-state result (upload-idempotency follow-up F10)
 * ---------------------------------------------------------------------------
 * `probeExistingUploadObject` reported "the object is not there" and "I could not
 * read the object state" with the SAME value (`null`), and the write-precondition
 * resolver then asserted `ifGenerationMatch: 0` — "the object must not exist" — for
 * both. Against an object that really exists, a degraded probe therefore 412'd, the
 * recovery attributed the write to a sibling, and the caller's bytes were silently
 * dropped (Req 9.13 forbids exactly that). `probeUploadObjectState` now reports
 * `found` / `absent` / `unreadable`, and the property below pins the mapping across
 * the same generated space: a 404 in any shape is `absent`, any other failure — and
 * any metadata whose normalization itself throws — is `unreadable`, and the union's
 * `object` field is exactly what the `probeExistingUploadObject` adapter returns, so
 * every pre-F10 consumer is unaffected.
 *
 * ---------------------------------------------------------------------------
 * Why this is worth a property test
 * ---------------------------------------------------------------------------
 * The probe runs on the critical path of EVERY opted-in upload and its entire job is
 * to fail safe: an escaped exception would turn a would-be-successful upload into a
 * `500`, converting orphan prevention into an availability regression. The space of
 * values a rejected promise can carry, and of shapes a metadata read can resolve
 * with, is unbounded — exactly what an example test cannot cover.
 *
 * ---------------------------------------------------------------------------
 * The counter clause
 * ---------------------------------------------------------------------------
 * `storage_upload_overwrite_probe_failed_total` is registered in `metrics.ts` (task
 * 6.1) and incremented from `probeExistingUploadObject`'s non-404 branch (task 6.2),
 * so the counter half of Property 13 is asserted here directly: exactly one
 * increment per non-404 failure, zero for a 404 and zero for a success, labelled by
 * `purpose` and by nothing else (Req 8.2, 8.4 — the object path embeds a
 * caller-supplied filename and must never become a label value, Req 6.4). The
 * warning-count assertions remain alongside it as the second observable Requirement
 * 9.2 states.
 *
 * The counter is observed through a pass-through `jest.spyOn` on the real `inc` seam
 * in `../metrics`: the increment itself still happens, the spy only records the
 * `(name, labels)` pairs so "exactly once" and "nothing but the purpose" can be
 * asserted. `metricsText()` is not used because it exposes no per-test reset, so
 * counts would leak between runs of a 200-iteration property.
 *
 * ---------------------------------------------------------------------------
 * Harness notes
 * ---------------------------------------------------------------------------
 * - The REAL exported `probeExistingUploadObject` is driven; nothing is
 *   re-implemented. The bucket is the only fake.
 * - Generators emit plain-data SPECS, and the hostile values (throwing getters,
 *   symbols, bigints) are materialized inside the property body. Generating the
 *   hostile objects directly would hand fast-check a value it has to stringify to
 *   report a counterexample, and stringifying a throwing getter is itself a hazard.
 * - `console.warn` is stubbed for the whole file: the failure branch logs on every
 *   run, and hundreds of lines of that would bury a real failure.
 */

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import * as fc from 'fast-check';

import {
  probeExistingUploadObject,
  probeUploadObjectState,
  type ExistingUploadObject,
  type UploadObjectProbeResult,
} from '../app';
import * as metrics from '../metrics';
import { metricNames } from '../metrics';
import type { StorageUploadPurpose } from '../lib/uploadObjectPath';

// ---------------------------------------------------------------------------
// console.warn + metrics capture
// ---------------------------------------------------------------------------
let warnSpy: jest.SpyInstance;
/** Pass-through: the real counter still increments; the spy only records calls. */
let incSpy: jest.SpyInstance;

beforeAll(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  incSpy = jest.spyOn(metrics, 'inc');
});

afterAll(() => {
  warnSpy.mockRestore();
  incSpy.mockRestore();
});

beforeEach(() => {
  warnSpy.mockClear();
  incSpy.mockClear();
});

/** Every metric the probe touched on this run, as `[name, labels]` pairs. */
function recordedMetrics(): Array<[string, Record<string, string> | undefined]> {
  return incSpy.mock.calls.map(([name, labels]) => [name, labels] as [string, Record<string, string> | undefined]);
}

/** The purpose used by the properties that are not about the label itself. */
const PROBE_PURPOSE: StorageUploadPurpose = 'chat';

const purposeArb = fc.constantFrom<StorageUploadPurpose>(
  'chat',
  'tenantLogo',
  'noticeImage',
  'noticeAudio',
  'studentProfile',
  'receipt',
  'profilePicture',
);

// ---------------------------------------------------------------------------
// Fake bucket that records every method invoked
// ---------------------------------------------------------------------------
/**
 * Every `File` method that writes, deletes or otherwise mutates the stored object.
 * Requirement 9.3 says the probe does none of these, so the fake exposes them all
 * and the property asserts none was ever touched.
 */
const MUTATING_FILE_METHODS = [
  'save',
  'delete',
  'setMetadata',
  'makePublic',
  'makePrivate',
  'copy',
  'move',
  'rename',
  'createWriteStream',
  'createResumableUpload',
  'rotateEncryptionKey',
  'setStorageClass',
  'deleteResumableCache',
] as const;

/** Bucket-level mutators, for the same reason. */
const MUTATING_BUCKET_METHODS = ['upload', 'deleteFiles', 'delete', 'setMetadata', 'makePublic', 'makePrivate'] as const;

/** What the fake `getMetadata()` (or `bucket.file()`) does on this run. */
type BucketBehavior =
  | { mode: 'reject'; value: unknown }
  | { mode: 'throwSync'; value: unknown }
  | { mode: 'fileThrows'; value: unknown }
  | { mode: 'resolve'; value: unknown };

interface ProbeHarness {
  bucket: any;
  /** Ordered log of every method invoked on the bucket or the file handle. */
  calls: string[];
  /** Every path passed to `bucket.file(...)`. */
  filePaths: string[];
}

function makeFakeBucket(behavior: BucketBehavior): ProbeHarness {
  const calls: string[] = [];
  const filePaths: string[] = [];

  const handle: any = {
    name: 'fake-file',
    getMetadata: () => {
      calls.push('file.getMetadata');
      if (behavior.mode === 'throwSync') throw behavior.value;
      if (behavior.mode === 'reject') return Promise.reject(behavior.value);
      return Promise.resolve(behavior.value);
    },
    exists: () => {
      calls.push('file.exists');
      return Promise.resolve([true]);
    },
    download: () => {
      calls.push('file.download');
      return Promise.resolve([Buffer.alloc(0)]);
    },
    get: () => {
      calls.push('file.get');
      return Promise.resolve([handle, {}]);
    },
  };
  for (const method of MUTATING_FILE_METHODS) {
    handle[method] = () => {
      calls.push(`file.${method}`);
      return Promise.resolve([]);
    };
  }

  const bucket: any = {
    name: 'fake-bucket',
    file: (path: string) => {
      calls.push('bucket.file');
      filePaths.push(path);
      if (behavior.mode === 'fileThrows') throw behavior.value;
      return handle;
    },
    getFiles: () => {
      calls.push('bucket.getFiles');
      return Promise.resolve([[]]);
    },
  };
  for (const method of MUTATING_BUCKET_METHODS) {
    bucket[method] = () => {
      calls.push(`bucket.${method}`);
      return Promise.resolve([]);
    };
  }

  return { bucket, calls, filePaths };
}

function mutatingCalls(calls: string[]): string[] {
  const mutators = new Set<string>([
    ...MUTATING_FILE_METHODS.map((m) => `file.${m}`),
    ...MUTATING_BUCKET_METHODS.map((m) => `bucket.${m}`),
  ]);
  return calls.filter((call) => mutators.has(call));
}

// ---------------------------------------------------------------------------
// Rejection specs (plain data; materialized in the property body)
// ---------------------------------------------------------------------------
/** The four places the implementation looks for an HTTP-ish status. */
type StatusField = 'code' | 'statusCode' | 'status' | 'response.status';

const STATUS_FIELDS: StatusField[] = ['code', 'statusCode', 'status', 'response.status'];

/** Statuses that are emphatically NOT "object missing". `4040`/`40` are near-misses. */
const NON_404_STATUSES = [0, 40, 400, 401, 403, 405, 409, 412, 429, 499, 500, 502, 503, 504, 4040];

type RejectionSpec =
  /** A 404 in one of the four shapes, as a number or a numeric string. */
  | { kind: 'notFound'; field: StatusField; asString: boolean; asError: boolean }
  /** A non-404 status in one of the same shapes. */
  | { kind: 'httpError'; status: number; field: StatusField; asString: boolean; asError: boolean }
  /** A bare `Error` with no status at all. */
  | { kind: 'plainError' }
  /** An `Error` whose `message` getter throws — the console.warn argument itself is hostile. */
  | { kind: 'errorWithThrowingMessage' }
  /** Not an `Error` at all. */
  | {
      kind: 'nonError';
      value:
        | 'string'
        | 'emptyString'
        | 'whitespaceString'
        | 'numericString404'
        | 'number'
        | 'zero'
        | 'nan'
        | 'null'
        | 'undefined'
        | 'symbol'
        | 'boolean'
        | 'object'
        | 'nonNumericCode'
        | 'array'
        | 'bigint';
    }
  /** An object whose property access itself throws — the reads are guarded one by one. */
  | { kind: 'throwingGetter'; field: StatusField | 'response' | 'all' };

function assignStatus(target: any, field: StatusField, raw: number | string): void {
  if (field === 'response.status') {
    target.response = { status: raw };
    return;
  }
  target[field] = raw;
}

function materializeRejection(spec: RejectionSpec): unknown {
  switch (spec.kind) {
    case 'notFound': {
      const carrier: any = spec.asError ? new Error('No such object: fake-bucket/some/object') : {};
      assignStatus(carrier, spec.field, spec.asString ? '404' : 404);
      return carrier;
    }
    case 'httpError': {
      const carrier: any = spec.asError ? new Error(`storage failure ${spec.status}`) : {};
      assignStatus(carrier, spec.field, spec.asString ? String(spec.status) : spec.status);
      return carrier;
    }
    case 'plainError':
      return new Error('metadata read failed');
    case 'errorWithThrowingMessage': {
      const error = new Error('unused');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('message getter exploded');
        },
      });
      return error;
    }
    case 'nonError':
      switch (spec.value) {
        case 'string':
          return 'not found, probably';
        case 'emptyString':
          return '';
        case 'whitespaceString':
          return '   ';
        case 'numericString404':
          // A bare string, NOT a carrier object: nothing to read a status off.
          return '404';
        case 'number':
          return 404;
        case 'zero':
          return 0;
        case 'nan':
          return NaN;
        case 'null':
          return null;
        case 'undefined':
          return undefined;
        case 'symbol':
          return Symbol('probe-failure');
        case 'boolean':
          return false;
        case 'object':
          return {};
        case 'nonNumericCode':
          return { code: 'ENOTFOUND', statusCode: 'nope', status: {}, response: { status: [] } };
        case 'array':
          return [404, 'not found'];
        case 'bigint':
          return 404n;
      }
      return {};
    case 'throwingGetter': {
      const carrier: any = {};
      const explode = () => {
        throw new Error('hostile property access');
      };
      const fields: Array<StatusField | 'response'> =
        spec.field === 'all' ? ['code', 'statusCode', 'status', 'response'] : [spec.field];
      for (const field of fields) {
        if (field === 'response.status') {
          const response: any = {};
          Object.defineProperty(response, 'status', { get: explode });
          carrier.response = response;
          continue;
        }
        Object.defineProperty(carrier, field, { get: explode });
      }
      return carrier;
    }
  }
}

const statusFieldArb = fc.constantFrom(...STATUS_FIELDS);

const notFoundSpecArb: fc.Arbitrary<RejectionSpec> = fc.record({
  kind: fc.constant('notFound' as const),
  field: statusFieldArb,
  asString: fc.boolean(),
  asError: fc.boolean(),
});

const failureSpecArb: fc.Arbitrary<RejectionSpec> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('httpError' as const),
      status: fc.constantFrom(...NON_404_STATUSES),
      field: statusFieldArb,
      asString: fc.boolean(),
      asError: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'plainError' as const }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('nonError' as const),
      value: fc.constantFrom(
        'string',
        'emptyString',
        'whitespaceString',
        'numericString404',
        'number',
        'zero',
        'nan',
        'null',
        'undefined',
        'symbol',
        'boolean',
        'object',
        'nonNumericCode',
        'array',
        'bigint',
      ),
    }) as fc.Arbitrary<RejectionSpec>,
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('throwingGetter' as const),
      field: fc.constantFrom<StatusField | 'response' | 'all'>(
        'code',
        'statusCode',
        'status',
        'response.status',
        'response',
        'all',
      ),
    }),
  },
);

/**
 * `Error` with a throwing `message` is kept out of `failureSpecArb`'s general pool
 * because its expected warn count differs (the log's own argument throws), and it is
 * asserted on its own instead.
 */
const throwingMessageSpec: RejectionSpec = { kind: 'errorWithThrowingMessage' };

// ---------------------------------------------------------------------------
// Resolved-metadata specs
// ---------------------------------------------------------------------------
type SizeSpec =
  | { kind: 'absent' }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bigint'; digits: string }
  | { kind: 'object' }
  | { kind: 'array' }
  | { kind: 'null' }
  | { kind: 'boolean' }
  | { kind: 'symbol' }
  | { kind: 'throwingGetter' };

type TokenSpec =
  | 'absent'
  | 'null'
  | 'empty'
  | 'whitespace'
  | 'single'
  | 'paddedSingle'
  | 'commaList'
  | 'paddedCommaList'
  | 'commasOnly'
  | 'leadingComma'
  | 'number'
  | 'object'
  | 'array'
  | 'boolean'
  | 'symbol';

/** How the `metadata` sub-object (or the whole resolved value) is shaped. */
type MetaShell =
  | 'tuple' // [metadata, apiResponse] — the real Admin SDK shape
  | 'bare' // a lone metadata object
  | 'emptyArray'
  | 'arrayWithNull'
  | 'arrayWithNumber'
  | 'null'
  | 'undefined'
  | 'number'
  | 'string'
  | 'boolean'
  | 'metadataGetterThrows'; // reading `.metadata` explodes

/**
 * How the top-level `generation` arrives (upload-idempotency follow-up F9). A GCS
 * generation is an int64 SERIALIZED AS A STRING, so the hostile pool is deliberately
 * heavy on values that would lose precision or invert the precondition's meaning if
 * they were coerced or waved through: 19-20 digit values beyond `Number.MAX_SAFE_INTEGER`,
 * `'0'` (which as `ifGenerationMatch` means "must NOT exist" — the opposite of "match
 * what I probed"), leading zeros, signs, floats and exponent notation.
 */
type GenerationSpec =
  | 'absent'
  | 'null'
  | 'typicalString'
  | 'int64String'
  | 'maxInt64String'
  | 'overlongDigits'
  | 'zeroString'
  | 'negativeString'
  | 'leadingZeroString'
  | 'paddedString'
  | 'floatString'
  | 'exponentString'
  | 'hexString'
  | 'emptyString'
  | 'whitespaceString'
  | 'nonNumericString'
  | 'safeNumber'
  | 'unsafeNumber'
  | 'floatNumber'
  | 'zeroNumber'
  | 'negativeNumber'
  | 'nan'
  | 'infinity'
  | 'bigint'
  | 'zeroBigint'
  | 'object'
  | 'array'
  | 'boolean'
  | 'symbol'
  | 'throwingGetter';

type MetadataSpec = {
  shell: MetaShell;
  size: SizeSpec;
  token: TokenSpec;
  generation: GenerationSpec;
  nestedMetadata: 'object' | 'null' | 'absent' | 'primitive';
};

const sizeSpecArb: fc.Arbitrary<SizeSpec> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ kind: 'absent' as const }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('number' as const),
      value: fc.constantFrom(
        0,
        1,
        1024,
        50 * 1024 * 1024,
        Number.MAX_SAFE_INTEGER,
        12.5,
        -1,
        -1024,
        -0,
        NaN,
        Infinity,
        -Infinity,
        1e308,
      ),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('string' as const),
      value: fc.constantFrom(
        '0',
        '1',
        '1024',
        '-1',
        '-4096',
        '',
        '   ',
        'abc',
        '12.5',
        '1e21',
        '0x10',
        '9'.repeat(30),
        '999999999999999999999999',
        'Infinity',
        'NaN',
        '1_000',
      ),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('bigint' as const), digits: fc.constantFrom('0', '1024', '9'.repeat(25)) }) },
  {
    weight: 3,
    arbitrary: fc.constantFrom<SizeSpec>(
      { kind: 'object' },
      { kind: 'array' },
      { kind: 'null' },
      { kind: 'boolean' },
      { kind: 'symbol' },
    ),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'throwingGetter' as const }) },
);

const tokenSpecArb = fc.constantFrom<TokenSpec>(
  'absent',
  'null',
  'empty',
  'whitespace',
  'single',
  'paddedSingle',
  'commaList',
  'paddedCommaList',
  'commasOnly',
  'leadingComma',
  'number',
  'object',
  'array',
  'boolean',
  'symbol',
);

const generationSpecArb = fc.constantFrom<GenerationSpec>(
  'absent',
  'null',
  'typicalString',
  'int64String',
  'maxInt64String',
  'overlongDigits',
  'zeroString',
  'negativeString',
  'leadingZeroString',
  'paddedString',
  'floatString',
  'exponentString',
  'hexString',
  'emptyString',
  'whitespaceString',
  'nonNumericString',
  'safeNumber',
  'unsafeNumber',
  'floatNumber',
  'zeroNumber',
  'negativeNumber',
  'nan',
  'infinity',
  'bigint',
  'zeroBigint',
  'object',
  'array',
  'boolean',
  'symbol',
  'throwingGetter',
);

const metadataSpecArb: fc.Arbitrary<MetadataSpec> = fc.record({
  shell: fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom<MetaShell>('tuple', 'bare') },
    {
      weight: 4,
      arbitrary: fc.constantFrom<MetaShell>(
        'emptyArray',
        'arrayWithNull',
        'arrayWithNumber',
        'null',
        'undefined',
        'number',
        'string',
        'boolean',
        'metadataGetterThrows',
      ),
    },
  ),
  size: sizeSpecArb,
  token: tokenSpecArb,
  generation: generationSpecArb,
  nestedMetadata: fc.constantFrom('object', 'null', 'absent', 'primitive'),
});

/** The raw value the fake metadata carries at its top-level `generation` key. */
function rawGenerationValue(spec: GenerationSpec): unknown {
  switch (spec) {
    case 'absent':
      return undefined;
    case 'null':
      return null;
    case 'typicalString':
      return '1712345678901234';
    case 'int64String':
      // Beyond Number.MAX_SAFE_INTEGER: `Number()` here would round.
      return '1712345678901234567';
    case 'maxInt64String':
      return '9223372036854775807';
    case 'overlongDigits':
      return '1'.repeat(25);
    case 'zeroString':
      return '0';
    case 'negativeString':
      return '-1712345678901234';
    case 'leadingZeroString':
      return '01712345678901234';
    case 'paddedString':
      return '  1712345678901234  ';
    case 'floatString':
      return '1712345678901234.5';
    case 'exponentString':
      return '1.7123e18';
    case 'hexString':
      return '0x1712345678901234';
    case 'emptyString':
      return '';
    case 'whitespaceString':
      return '   ';
    case 'nonNumericString':
      return 'generation';
    case 'safeNumber':
      return 1712345678;
    case 'unsafeNumber':
      return 1712345678901234567;
    case 'floatNumber':
      return 12.5;
    case 'zeroNumber':
      return 0;
    case 'negativeNumber':
      return -17;
    case 'nan':
      return NaN;
    case 'infinity':
      return Infinity;
    case 'bigint':
      return 1712345678901234567n;
    case 'zeroBigint':
      return 0n;
    case 'object':
      return { generation: '17' };
    case 'array':
      return ['17'];
    case 'boolean':
      return true;
    case 'symbol':
      return Symbol('generation');
    case 'throwingGetter':
      return undefined; // never read; the getter is installed instead
  }
}

function rawSizeValue(spec: SizeSpec): unknown {
  switch (spec.kind) {
    case 'absent':
      return undefined;
    case 'number':
      return spec.value;
    case 'string':
      return spec.value;
    case 'bigint':
      return BigInt(spec.digits);
    case 'object':
      return { bytes: 10 };
    case 'array':
      return [1024];
    case 'null':
      return null;
    case 'boolean':
      return true;
    case 'symbol':
      return Symbol('size');
    case 'throwingGetter':
      return undefined; // never read; the getter is installed instead
  }
}

function rawTokenValue(spec: TokenSpec): unknown {
  switch (spec) {
    case 'absent':
      return undefined;
    case 'null':
      return null;
    case 'empty':
      return '';
    case 'whitespace':
      return '   ';
    case 'single':
      return 'abc-123';
    case 'paddedSingle':
      return '  abc-123  ';
    case 'commaList':
      return 'first-token,second-token,third';
    case 'paddedCommaList':
      return '  first-token , second-token ';
    case 'commasOnly':
      return ',,,';
    case 'leadingComma':
      return ',second-token';
    case 'number':
      return 42;
    case 'object':
      return { firebaseStorageDownloadTokens: 'nested' };
    case 'array':
      return ['array-token'];
    case 'boolean':
      return true;
    case 'symbol':
      return Symbol('token');
  }
}

function buildMetadataObject(spec: MetadataSpec): any {
  const metadataObject: any = {
    contentType: 'image/jpeg',
    updated: '2024-01-01T00:00:00.000Z',
  };

  if (spec.size.kind === 'throwingGetter') {
    Object.defineProperty(metadataObject, 'size', {
      get() {
        throw new Error('hostile size access');
      },
      enumerable: true,
    });
  } else if (spec.size.kind !== 'absent') {
    metadataObject.size = rawSizeValue(spec.size);
  }

  if (spec.generation === 'throwingGetter') {
    Object.defineProperty(metadataObject, 'generation', {
      get() {
        throw new Error('hostile generation access');
      },
      enumerable: true,
    });
  } else if (spec.generation !== 'absent') {
    metadataObject.generation = rawGenerationValue(spec.generation);
  }

  const nested =
    spec.nestedMetadata === 'object'
      ? (() => {
          const bag: any = { customKey: 'v' };
          const raw = rawTokenValue(spec.token);
          if (raw !== undefined) bag.firebaseStorageDownloadTokens = raw;
          return bag;
        })()
      : spec.nestedMetadata === 'null'
        ? null
        : spec.nestedMetadata === 'primitive'
          ? 'not-an-object'
          : undefined;

  if (spec.shell === 'metadataGetterThrows') {
    Object.defineProperty(metadataObject, 'metadata', {
      get() {
        throw new Error('hostile metadata access');
      },
      enumerable: true,
    });
  } else if (spec.nestedMetadata !== 'absent') {
    metadataObject.metadata = nested;
  }

  return metadataObject;
}

function materializeResolved(spec: MetadataSpec): unknown {
  const metadataObject = buildMetadataObject(spec);
  switch (spec.shell) {
    case 'tuple':
      return [metadataObject, { statusCode: 200 }];
    case 'bare':
    case 'metadataGetterThrows':
      return metadataObject;
    case 'emptyArray':
      return [];
    case 'arrayWithNull':
      return [null, {}];
    case 'arrayWithNumber':
      return [42];
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'number':
      return 1024;
    case 'string':
      return 'metadata';
    case 'boolean':
      return true;
  }
}

// ---------------------------------------------------------------------------
// Oracle: the normalization contract the design states, expressed independently
// ---------------------------------------------------------------------------
/**
 * Design contract: "Normalize `size` to a finite non-negative number". A value that
 * cannot be read as a positive finite number carries no usable information about the
 * stored object, so it degrades to 0 — which makes the quota delta reserve the full
 * file, i.e. it over-reserves rather than under-counts (Req 9.4).
 */
function expectedBytes(raw: unknown): number {
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'bigint'
        ? Number(raw)
        : typeof raw === 'string'
          ? Number(raw)
          : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
}

/**
 * Design contract: "take the FIRST value of a comma-joined
 * `firebaseStorageDownloadTokens`, or `null`". Anything that is not a non-empty
 * string after that reduction is `null`, so the caller mints a fresh token.
 */
function expectedToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0]?.trim() ?? '';
  return first.length > 0 ? first : null;
}

/**
 * Design contract (F9): the `generation` is carried through as a DECIMAL STRING and
 * is `null` whenever it cannot be read as a real int64 generation. `Number()` is
 * never applied — a 19-digit generation does not survive it — so this oracle is a
 * string test, not an arithmetic one. `0` is excluded because
 * `ifGenerationMatch: 0` means "the object must NOT exist", the opposite of "match
 * the version I probed", so a bogus zero must degrade to "no precondition" rather
 * than invert the write's meaning.
 */
function expectedGeneration(raw: unknown): string | null {
  const text =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number'
        ? Number.isSafeInteger(raw) && raw > 0
          ? String(raw)
          : ''
        : typeof raw === 'bigint'
          ? raw > 0n
            ? raw.toString()
            : ''
          : '';
  return /^[1-9][0-9]{0,19}$/.test(text) ? text : null;
}

/** What the probe should hand back for a given resolved-metadata spec. */
function expectedProbeResult(spec: MetadataSpec): ExistingUploadObject | null {
  // Reading a hostile getter throws inside the probe's normalization step; the
  // backstop catch degrades to `null` rather than letting it escape.
  if (spec.shell === 'metadataGetterThrows') return null;
  const carriesMetadataObject = spec.shell === 'tuple' || spec.shell === 'bare';
  if (carriesMetadataObject && (spec.size.kind === 'throwingGetter' || spec.generation === 'throwingGetter')) {
    return null;
  }

  if (!carriesMetadataObject) {
    // No readable metadata object at all ⇒ a zero-byte, token-less, generation-less
    // view of the object, which is still well-formed. A `null` generation means the
    // write below sends no precondition, i.e. today's last-writer-wins.
    return { bytes: 0, downloadToken: null, generation: null };
  }

  const rawSize = spec.size.kind === 'absent' ? undefined : rawSizeValue(spec.size);
  const rawToken = spec.nestedMetadata === 'object' ? rawTokenValue(spec.token) : undefined;
  const rawGeneration = spec.generation === 'absent' ? undefined : rawGenerationValue(spec.generation);
  return {
    bytes: expectedBytes(rawSize),
    downloadToken: expectedToken(rawToken),
    generation: expectedGeneration(rawGeneration),
  };
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------
const objectPathArb = fc.constantFrom(
  'chat-files/acme/c_0123456789/k_0123456789abcdef0123_photo.jpg',
  'receipts/acme/fee_77/k_abcdefabcdefabcdefab_march.pdf',
  'notices/tenant_1/notice_k_ffffffffffffffffffff.png',
  'student_profiles/T-42/k_00000000000000000000_profile.jpg',
  'profile-pictures/acme/1f2e3d4c5b6a79880011.jpg',
  'tenant-branding/acme/logo_k_aaaaaaaaaaaaaaaaaaaa.webp',
);

/** Property 13's shape half: `null`, or an `ExistingUploadObject` that is safe to use. */
function assertWellFormed(result: ExistingUploadObject | null): void {
  if (result === null) return;

  expect(typeof result).toBe('object');
  expect(typeof result.bytes).toBe('number');
  expect(Number.isFinite(result.bytes)).toBe(true);
  expect(Number.isNaN(result.bytes)).toBe(false);
  expect(result.bytes).toBeGreaterThanOrEqual(0);

  if (result.downloadToken !== null) {
    expect(typeof result.downloadToken).toBe('string');
    expect(result.downloadToken.length).toBeGreaterThan(0);
    expect(result.downloadToken.trim().length).toBeGreaterThan(0);
  }

  // F9: whatever comes back here is fed straight to Storage as `ifGenerationMatch`,
  // so "safe to use" means a real int64 generation as a decimal string, or `null`
  // (which sends no precondition at all). Never `'0'` — that would invert the
  // precondition into "the object must not exist".
  if (result.generation !== null) {
    expect(typeof result.generation).toBe('string');
    expect(result.generation).toMatch(/^[1-9][0-9]{0,19}$/);
    // No precision was lost on the way here: the string still round-trips as itself.
    expect(BigInt(result.generation).toString()).toBe(result.generation);
  }
}

/** Requirement 9.3: read-only. One `file()` lookup, `getMetadata()` and nothing else. */
function assertReadOnly(harness: ProbeHarness, objectPath: string, expectGetMetadata: boolean): void {
  expect(mutatingCalls(harness.calls)).toEqual([]);
  expect(harness.filePaths).toEqual([objectPath]);
  expect(harness.calls.filter((c) => c === 'bucket.file')).toHaveLength(1);
  expect(harness.calls.filter((c) => c === 'file.getMetadata')).toHaveLength(expectGetMetadata ? 1 : 0);
  // No other read either — one round trip per probe (Req 1.7).
  expect(harness.calls).toEqual(expectGetMetadata ? ['bucket.file', 'file.getMetadata'] : ['bucket.file']);
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------
type BehaviorSpec =
  | { via: 'reject'; rejection: RejectionSpec }
  | { via: 'throwSync'; rejection: RejectionSpec }
  | { via: 'fileThrows'; rejection: RejectionSpec }
  | { via: 'resolve'; metadata: MetadataSpec };

const rejectionSpecArb: fc.Arbitrary<RejectionSpec> = fc.oneof(
  { weight: 3, arbitrary: notFoundSpecArb },
  { weight: 7, arbitrary: failureSpecArb },
);

const behaviorSpecArb: fc.Arbitrary<BehaviorSpec> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ via: fc.constant('reject' as const), rejection: rejectionSpecArb }) },
  { weight: 2, arbitrary: fc.record({ via: fc.constant('throwSync' as const), rejection: rejectionSpecArb }) },
  { weight: 1, arbitrary: fc.record({ via: fc.constant('fileThrows' as const), rejection: rejectionSpecArb }) },
  { weight: 6, arbitrary: fc.record({ via: fc.constant('resolve' as const), metadata: metadataSpecArb }) },
);

function toBucketBehavior(spec: BehaviorSpec): BucketBehavior {
  if (spec.via === 'resolve') return { mode: 'resolve', value: materializeResolved(spec.metadata) };
  const value = materializeRejection(spec.rejection);
  if (spec.via === 'reject') return { mode: 'reject', value };
  if (spec.via === 'throwSync') return { mode: 'throwSync', value };
  return { mode: 'fileThrows', value };
}

describe('Property 13: The existing-object probe is total', () => {
  it('always resolves — never rejects — and always yields null or a well-formed ExistingUploadObject', async () => {
    await fc.assert(
      fc.asyncProperty(behaviorSpecArb, objectPathArb, async (spec, objectPath) => {
        warnSpy.mockClear();
        const harness = makeFakeBucket(toBucketBehavior(spec));

        // The whole point: awaiting this must never reject, whatever the bucket did.
        const result = await probeExistingUploadObject(harness.bucket, objectPath, PROBE_PURPOSE);

        assertWellFormed(result);
        assertReadOnly(harness, objectPath, spec.via !== 'fileThrows');

        if (spec.via === 'resolve') {
          // A successful read is never reported as a failure.
          expect(warnSpy).not.toHaveBeenCalled();
        }
      }),
      { numRuns: 400 },
    );
  });

  it('resolves to exactly null for a 404 in any shape the code checks, and logs nothing (Req 9.1)', async () => {
    await fc.assert(
      fc.asyncProperty(
        notFoundSpecArb,
        fc.constantFrom<BehaviorSpec['via']>('reject', 'throwSync', 'fileThrows'),
        objectPathArb,
        async (rejection, via, objectPath) => {
          warnSpy.mockClear();
          const harness = makeFakeBucket(toBucketBehavior({ via, rejection } as BehaviorSpec));

          const result = await probeExistingUploadObject(harness.bucket, objectPath, PROBE_PURPOSE);

          expect(result).toBeNull();
          // A missing object is the expected first-attempt case, not a failure.
          expect(warnSpy).not.toHaveBeenCalled();
          assertReadOnly(harness, objectPath, via !== 'fileThrows');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('degrades any non-404 failure to null after exactly one warning (Req 9.2)', async () => {
    await fc.assert(
      fc.asyncProperty(
        failureSpecArb,
        fc.constantFrom<BehaviorSpec['via']>('reject', 'throwSync', 'fileThrows'),
        objectPathArb,
        async (rejection, via, objectPath) => {
          warnSpy.mockClear();
          const harness = makeFakeBucket(toBucketBehavior({ via, rejection } as BehaviorSpec));

          const result = await probeExistingUploadObject(harness.bucket, objectPath, PROBE_PURPOSE);

          expect(result).toBeNull();
          expect(warnSpy).toHaveBeenCalledTimes(1);
          assertReadOnly(harness, objectPath, via !== 'fileThrows');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('survives a rejection whose own log formatting throws', async () => {
    // `console.warn(msg, error instanceof Error ? error.message : typeof error)` — a
    // throwing `message` getter blows up while the ARGUMENTS are evaluated, so the
    // warn may legitimately never be issued. What must still hold is totality.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<BehaviorSpec['via']>('reject', 'throwSync', 'fileThrows'),
        objectPathArb,
        async (via, objectPath) => {
          warnSpy.mockClear();
          incSpy.mockClear();
          const harness = makeFakeBucket(toBucketBehavior({ via, rejection: throwingMessageSpec } as BehaviorSpec));

          const result = await probeExistingUploadObject(harness.bucket, objectPath, PROBE_PURPOSE);

          expect(result).toBeNull();
          expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(1);
          // A log that blew up while formatting its own arguments must not cost the
          // increment: the counter is what an operator watches, and this is still a
          // non-404 failure (Req 8.2).
          expect(recordedMetrics()).toEqual([[metricNames.storageUploadOverwriteProbeFailed, { purpose: PROBE_PURPOSE }]]);
          assertReadOnly(harness, objectPath, via !== 'fileThrows');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('normalizes every malformed resolved metadata shape into a usable value', async () => {
    await fc.assert(
      fc.asyncProperty(metadataSpecArb, objectPathArb, async (spec, objectPath) => {
        warnSpy.mockClear();
        const harness = makeFakeBucket({ mode: 'resolve', value: materializeResolved(spec) });

        const result = await probeExistingUploadObject(harness.bucket, objectPath, PROBE_PURPOSE);

        assertWellFormed(result);
        expect(result).toEqual(expectedProbeResult(spec));
        expect(warnSpy).not.toHaveBeenCalled();
        assertReadOnly(harness, objectPath, true);
      }),
      { numRuns: 400 },
    );
  });

  it('carries a real int64 generation through as an exact decimal string, and degrades every other shape to null (F9)', async () => {
    // Example-anchored companion to the generated property above: these are the
    // values whose mis-handling would be silent rather than loud.
    const cases: Array<[unknown, string | null]> = [
      ['1712345678901234567', '1712345678901234567'], // > Number.MAX_SAFE_INTEGER
      ['9223372036854775807', '9223372036854775807'], // int64 max
      ['  1712345678901234  ', '1712345678901234'],
      [1712345678901234567n, '1712345678901234567'],
      ['0', null], // would mean "must NOT exist"
      [0, null],
      ['01712345678901234', null], // leading zero is not a real generation
      ['-1712345678901234', null],
      ['1.7123e18', null],
      ['1712345678901234.5', null],
      ['0x1712345678901234', null],
      ['1'.repeat(25), null], // cannot be an int64
      [undefined, null],
      [{ generation: '17' }, null],
    ];

    for (const [raw, expected] of cases) {
      const harness = makeFakeBucket({
        mode: 'resolve',
        value: [{ size: '1024', generation: raw, metadata: { firebaseStorageDownloadTokens: 'tok' } }, {}],
      });

      const result = await probeExistingUploadObject(harness.bucket, 'chat-files/acme/c_x/k_y_photo.jpg', PROBE_PURPOSE);

      expect(result).not.toBeNull();
      expect(result!.generation).toBe(expected);
      assertWellFormed(result);
    }
  });

  it('never writes: no mutating bucket or file method is invoked on any run (Req 9.3)', async () => {
    await fc.assert(
      fc.asyncProperty(behaviorSpecArb, objectPathArb, async (spec, objectPath) => {
        warnSpy.mockClear();
        const harness = makeFakeBucket(toBucketBehavior(spec));

        await probeExistingUploadObject(harness.bucket, objectPath, PROBE_PURPOSE);

        expect(mutatingCalls(harness.calls)).toEqual([]);
        for (const method of MUTATING_FILE_METHODS) {
          expect(harness.calls).not.toContain(`file.${method}`);
        }
        for (const method of MUTATING_BUCKET_METHODS) {
          expect(harness.calls).not.toContain(`bucket.${method}`);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('leaves the probed metadata object unmutated, even when it is frozen', async () => {
    // A frozen metadata object turns any write attempt into a TypeError under strict
    // mode, so this catches a mutation that a call log alone would miss.
    await fc.assert(
      fc.asyncProperty(metadataSpecArb, objectPathArb, async (spec, objectPath) => {
        warnSpy.mockClear();
        const raw = materializeResolved(spec);
        if (Array.isArray(raw)) {
          raw.forEach((entry) => {
            if (entry && typeof entry === 'object') Object.freeze(entry);
          });
          Object.freeze(raw);
        } else if (raw && typeof raw === 'object') {
          Object.freeze(raw);
        }

        const result = await probeExistingUploadObject(makeFakeBucket({ mode: 'resolve', value: raw }).bucket, objectPath, PROBE_PURPOSE);

        assertWellFormed(result);
        expect(result).toEqual(expectedProbeResult(spec));
      }),
      { numRuns: 200 },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 13's counter clause (task 6.2): "non-404 failures increment the
  // probe-failure counter exactly once; 404s and successes increment it zero times."
  // ─────────────────────────────────────────────────────────────────────────
  it('increments storage_upload_overwrite_probe_failed_total exactly once per non-404 failure, labelled by purpose only', async () => {
    await fc.assert(
      fc.asyncProperty(
        failureSpecArb,
        fc.constantFrom<BehaviorSpec['via']>('reject', 'throwSync', 'fileThrows'),
        objectPathArb,
        purposeArb,
        async (rejection, via, objectPath, purpose) => {
          warnSpy.mockClear();
          incSpy.mockClear();
          const harness = makeFakeBucket(toBucketBehavior({ via, rejection } as BehaviorSpec));

          const result = await probeExistingUploadObject(harness.bucket, objectPath, purpose);

          expect(result).toBeNull();
          // Exactly one increment, of exactly that counter, and no other metric —
          // whatever the rejection carried and wherever it was thrown from.
          expect(recordedMetrics()).toEqual([[metricNames.storageUploadOverwriteProbeFailed, { purpose }]]);
          expect(metricNames.storageUploadOverwriteProbeFailed).toBe('storage_upload_overwrite_probe_failed_total');

          // Req 6.4 / 8.4: `purpose` is the ONLY label, and nothing derived from the
          // object path (whose trailing segment embeds a caller-supplied filename, and
          // whose `k_…` segment embeds the upload-key hash) reaches a label value.
          const [[, labels]] = recordedMetrics();
          expect(Object.keys(labels ?? {})).toEqual(['purpose']);
          const serialized = JSON.stringify(recordedMetrics());
          expect(serialized).not.toContain(objectPath);
          for (const segment of objectPath.split('/')) {
            expect(serialized).not.toContain(segment);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('increments the probe-failure counter zero times for a 404 in any shape', async () => {
    await fc.assert(
      fc.asyncProperty(
        notFoundSpecArb,
        fc.constantFrom<BehaviorSpec['via']>('reject', 'throwSync', 'fileThrows'),
        objectPathArb,
        purposeArb,
        async (rejection, via, objectPath, purpose) => {
          warnSpy.mockClear();
          incSpy.mockClear();
          const harness = makeFakeBucket(toBucketBehavior({ via, rejection } as BehaviorSpec));

          const result = await probeExistingUploadObject(harness.bucket, objectPath, purpose);

          // A missing object is the expected first-attempt case, not a failure: a
          // counter that counted it would make the metric useless for spotting real
          // Storage trouble (Req 9.1 vs 9.2).
          expect(result).toBeNull();
          expect(recordedMetrics()).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 13's state clause (follow-up F10): "a 404 is reported as `absent`,
  // every other failure — and any metadata whose normalization throws — as
  // `unreadable`, and the union's `object` is exactly what the
  // `probeExistingUploadObject` adapter returns."
  //
  // The regression this pins: with absence and failure sharing one value,
  // `resolveUploadSavePrecondition` asserted `ifGenerationMatch: 0` for a degraded
  // probe, which 412s against an object that really exists and silently drops the
  // caller's bytes (Req 9.13).
  // ─────────────────────────────────────────────────────────────────────────
  it('reports absent for a 404, unreadable for every other failure, and found for a readable object (F10)', async () => {
    /** The adapter must stay exactly `(await probeUploadObjectState(...)).object`. */
    const assertAgreesWithAdapter = async (
      behavior: BucketBehavior,
      objectPath: string,
      state: UploadObjectProbeResult
    ): Promise<void> => {
      // A second identical bucket, because each harness records its own calls.
      const adapterResult = await probeExistingUploadObject(makeFakeBucket(behavior).bucket, objectPath, PROBE_PURPOSE);
      expect(state.object).toEqual(adapterResult);
      if (state.state === 'found') {
        expect(state.object).not.toBeNull();
      } else {
        expect(state.object).toBeNull();
      }
    };

    // 1. A 404, however it arrives, is a genuine absence — the one case that may
    //    still carry `ifGenerationMatch: 0`.
    await fc.assert(
      fc.asyncProperty(
        notFoundSpecArb,
        fc.constantFrom<BehaviorSpec['via']>('reject', 'throwSync', 'fileThrows'),
        objectPathArb,
        async (rejection, via, objectPath) => {
          warnSpy.mockClear();
          const behavior = toBucketBehavior({ via, rejection } as BehaviorSpec);
          const result = await probeUploadObjectState(makeFakeBucket(behavior).bucket, objectPath, PROBE_PURPOSE);

          expect(result.state).toBe('absent');
          await assertAgreesWithAdapter(behavior, objectPath, result);
        }
      ),
      { numRuns: 150 }
    );

    // 2. Any non-404 failure leaves the state UNKNOWN, whatever the rejection
    //    carried and wherever it was thrown from.
    await fc.assert(
      fc.asyncProperty(
        failureSpecArb,
        fc.constantFrom<BehaviorSpec['via']>('reject', 'throwSync', 'fileThrows'),
        objectPathArb,
        async (rejection, via, objectPath) => {
          warnSpy.mockClear();
          const behavior = toBucketBehavior({ via, rejection } as BehaviorSpec);
          const result = await probeUploadObjectState(makeFakeBucket(behavior).bucket, objectPath, PROBE_PURPOSE);

          expect(result.state).toBe('unreadable');
          await assertAgreesWithAdapter(behavior, objectPath, result);
        }
      ),
      { numRuns: 200 }
    );

    // 3. A successful read is `found` with the normalized object — except where the
    //    normalization itself threw on a hostile shape, which is the outer
    //    backstop and is also "state unknown".
    await fc.assert(
      fc.asyncProperty(metadataSpecArb, objectPathArb, async (spec, objectPath) => {
        warnSpy.mockClear();
        const behavior: BucketBehavior = { mode: 'resolve', value: materializeResolved(spec) };
        const result = await probeUploadObjectState(makeFakeBucket(behavior).bucket, objectPath, PROBE_PURPOSE);

        const expected = expectedProbeResult(spec);
        expect(result.state).toBe(expected === null ? 'unreadable' : 'found');
        expect(result.object).toEqual(expected);
        assertWellFormed(result.object);
      }),
      { numRuns: 300 }
    );
  });

  it('increments the probe-failure counter zero times for a successful read of any metadata shape', async () => {
    await fc.assert(
      fc.asyncProperty(metadataSpecArb, objectPathArb, purposeArb, async (spec, objectPath, purpose) => {
        warnSpy.mockClear();
        incSpy.mockClear();
        const harness = makeFakeBucket({ mode: 'resolve', value: materializeResolved(spec) });

        const result = await probeExistingUploadObject(harness.bucket, objectPath, purpose);

        // Includes the hostile-getter shapes, where normalization throws and the
        // backstop returns `null`: that is a successful READ, not a probe failure, so
        // it must not be counted as one either.
        expect(result).toEqual(expectedProbeResult(spec));
        expect(recordedMetrics()).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
