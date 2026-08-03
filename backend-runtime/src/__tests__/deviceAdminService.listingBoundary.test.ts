/**
 * Unit tests for the scoped-listing boundary + rollout helpers (Task 3.3).
 *
 * Example-based coverage for the pure/near-pure helpers introduced with the
 * scoped listing path:
 *
 *   - `listTenantDevices` rejects an empty / whitespace-after-trim tenant id
 *     with `InvalidTenantIdError` BEFORE any Firestore access — documenting the
 *     deliberate `''` predicate asymmetry (`matchesTenantDevice('')` matches
 *     everything, `array-contains('')` matches nothing), which the listing
 *     boundary closes (Req 7.4).
 *   - `isIndexUnavailableError` classifies Firestore `FAILED_PRECONDITION`
 *     (gRPC code 9 / string status) and `"requires an index"` messages as
 *     index-unavailable (true), and unrelated errors as not (false) (Req 8.4).
 *   - Flag-off / flag-on decision examples via `isScopedListingEnabled` +
 *     `decideListingMode` (Req 8.1, 8.2).
 *
 * The real, exported helpers/classes are imported and exercised directly. The
 * empty-id boundary is verifiable without a Firestore stub because the trim +
 * reject happens before `getFirestore()` is ever called; to be certain no read
 * occurs, `../firebaseAdmin` is mocked so `getFirestore` would throw if invoked.
 */

import {
  isIndexUnavailableError,
  isScopedListingEnabled,
  decideListingMode,
  listTenantDevices,
  InvalidTenantIdError,
  DeviceAdminError,
} from '../deviceAdminService';

// If the empty-id guard ever fell through to a Firestore read, this mocked
// `getFirestore` would throw and fail the test loudly (instead of silently
// hitting a real client).
jest.mock('../firebaseAdmin', () => ({
  getFirestore: jest.fn(() => {
    throw new Error('getFirestore must not be called for an invalid tenant id');
  }),
}));

// ---------------------------------------------------------------------------
// listTenantDevices — empty / whitespace tenant id boundary (Req 7.4)
// ---------------------------------------------------------------------------

describe('listTenantDevices — empty/whitespace tenant id boundary (Req 7.4)', () => {
  const invalidIds = ['', ' ', '   ', '\t', '\n', ' \t \n '];

  it.each(invalidIds)('rejects %j with InvalidTenantIdError before any Firestore read', async (id) => {
    await expect(listTenantDevices(id)).rejects.toBeInstanceOf(InvalidTenantIdError);
  });

  it('InvalidTenantIdError carries code "invalid_tenant_id" and status 400', async () => {
    const error = await listTenantDevices('   ').catch((e) => e);
    expect(error).toBeInstanceOf(InvalidTenantIdError);
    expect(error).toBeInstanceOf(DeviceAdminError); // part of the mapped hierarchy
    expect((error as InvalidTenantIdError).code).toBe('invalid_tenant_id');
    expect((error as InvalidTenantIdError).status).toBe(400);
  });

  it('a standalone InvalidTenantIdError instance has the documented code/status', () => {
    const error = new InvalidTenantIdError();
    expect(error).toBeInstanceOf(DeviceAdminError);
    expect(error.code).toBe('invalid_tenant_id');
    expect(error.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// isIndexUnavailableError — FAILED_PRECONDITION / "requires an index" (Req 8.4)
// ---------------------------------------------------------------------------

describe('isIndexUnavailableError — index-unavailable classification (Req 8.4)', () => {
  const indexUnavailable: Array<{ label: string; err: unknown }> = [
    { label: 'gRPC numeric code 9 (FAILED_PRECONDITION)', err: { code: 9, message: 'some detail' } },
    {
      label: 'string code FAILED_PRECONDITION',
      err: { code: 'FAILED_PRECONDITION', message: 'x' },
    },
    {
      label: 'string status FAILED_PRECONDITION',
      err: { status: 'FAILED_PRECONDITION', message: 'x' },
    },
    {
      label: 'message containing "requires an index"',
      err: new Error('9 FAILED_PRECONDITION: The query requires an index. Create it here: ...'),
    },
    {
      label: 'message "requires an index" without an explicit code',
      err: { message: 'This query requires an index that is still building' },
    },
  ];

  it.each(indexUnavailable)('classifies $label as index-unavailable (true)', ({ err }) => {
    expect(isIndexUnavailableError(err)).toBe(true);
  });

  const unrelated: Array<{ label: string; err: unknown }> = [
    { label: 'a generic Error', err: new Error('firestore unavailable') },
    { label: 'a permission-denied gRPC error (code 7)', err: { code: 7, message: 'PERMISSION_DENIED' } },
    { label: 'a not-found gRPC error (code 5)', err: { code: 5, message: 'NOT_FOUND' } },
    { label: 'null', err: null },
    { label: 'undefined', err: undefined },
    { label: 'a plain string', err: 'requires an index' }, // non-object: not classified
    { label: 'an unrelated object', err: { foo: 'bar' } },
    { label: 'a number', err: 9 }, // non-object: not classified
  ];

  it.each(unrelated)('classifies $label as NOT index-unavailable (false)', ({ err }) => {
    expect(isIndexUnavailableError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Feature flag + decision examples (Req 8.1, 8.2)
// ---------------------------------------------------------------------------

describe('isScopedListingEnabled + decideListingMode — flag examples (Req 8.1, 8.2)', () => {
  // `process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED` is accessed with a literal
  // key (never `process.env[someVar]`) so the env var stays statically
  // analysable — see `expo/no-dynamic-env-var`.
  const original = process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED;
    } else {
      process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED = original;
    }
  });

  it('isScopedListingEnabled is true only for exactly "1"', () => {
    process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED = '1';
    expect(isScopedListingEnabled()).toBe(true);

    for (const value of ['0', 'true', 'yes', '', ' 1 ', '01']) {
      process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED = value;
      expect(isScopedListingEnabled()).toBe(false);
    }

    delete process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED;
    expect(isScopedListingEnabled()).toBe(false);
  });

  it('flag OFF ⇒ fallback even when the backfill has completed (Req 8.1)', () => {
    expect(decideListingMode({ flagEnabled: false, backfillCompleted: true })).toBe('fallback');
  });

  it('flag ON + backfill completed ⇒ scoped (Req 8.2)', () => {
    expect(decideListingMode({ flagEnabled: true, backfillCompleted: true })).toBe('scoped');
  });
});
