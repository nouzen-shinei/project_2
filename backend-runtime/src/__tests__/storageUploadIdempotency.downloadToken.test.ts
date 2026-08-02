// Feature: upload-idempotency, Task 4.4: download-token reuse keeps the returned URL stable
//
// Unit coverage for the exported token-selection seam and the download-URL builder
// that `POST /storage/upload` uses (Requirements 4.1–4.4). The property-level
// coverage of the same seam (design Property 12) lands in task 5.2; this file pins
// the concrete branches: reuse, each "mint fresh" trigger, and url stability.

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import {
  resolveUploadDownloadToken,
  selectUploadDownloadToken,
  buildUploadDownloadUrl,
  type ExistingUploadObject,
} from '../app';

const existingWith = (downloadToken: ExistingUploadObject['downloadToken']): ExistingUploadObject => ({
  bytes: 1024,
  downloadToken,
  // Irrelevant to token selection (F9 added it for the write precondition), but
  // present so this is a real probe result rather than a partial one.
  generation: '1712345678901234567',
});

describe('selectUploadDownloadToken', () => {
  it('reuses the token the probe read off the stored object (Req 4.1)', () => {
    expect(selectUploadDownloadToken(existingWith('abc-123'))).toBe('abc-123');
  });

  it('mints a fresh token when no object was probed — the legacy path (Req 2.4, 4.3)', () => {
    const token = selectUploadDownloadToken(null);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('mints a fresh token when the stored object carries no usable token (Req 4.3)', () => {
    for (const raw of [null, '', '   ']) {
      const token = selectUploadDownloadToken(existingWith(raw as any));
      expect(token).not.toBe(raw);
      expect(token.trim().length).toBeGreaterThan(0);
    }
  });

  it('mints a different token on each fresh selection', () => {
    const a = selectUploadDownloadToken(null);
    const b = selectUploadDownloadToken(null);
    expect(a).not.toBe(b);
  });

  it('reuses a comma-joined token value as-is without re-splitting it', () => {
    // `probeExistingUploadObject` already reduced the raw metadata list to its
    // first entry, so this seam does no further normalization.
    expect(selectUploadDownloadToken(existingWith('first-token,second-token'))).toBe('first-token,second-token');
  });

  it('is total: never throws for a malformed shape, it degrades to a fresh token', () => {
    const hostile: unknown[] = [
      undefined,
      {},
      { bytes: NaN, downloadToken: 42 },
      { bytes: 0, downloadToken: {} },
      { get downloadToken() { return undefined; }, bytes: 1 },
    ];
    for (const value of hostile) {
      expect(() => selectUploadDownloadToken(value as any)).not.toThrow();
      expect(selectUploadDownloadToken(value as any).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveUploadDownloadToken (upload-idempotency follow-up F10)
// ---------------------------------------------------------------------------
//
// `reused` is what `saveUploadObjectWithPrecondition` uses to attribute a `412`: a
// freshly minted token found stored can only be this request's own write, while a
// reused one is what BOTH racers wrote. The route used to re-derive that flag by
// comparing `existing?.downloadToken` against the selected token — correct only
// because the two sides trimmed identically. If either normalization had diverged,
// a lost race would have been mis-attributed as `written` and the route would have
// re-run the shrink release the winner already performed: a double credit, i.e. the
// under-count Requirement 9.4 forbids. The flag is now decided here, once.
describe('resolveUploadDownloadToken', () => {
  it('reports reuse when the token came off the probed object', () => {
    expect(resolveUploadDownloadToken(existingWith('abc-123'))).toEqual({ token: 'abc-123', reused: true });
  });

  it('reports reuse for a token that needed trimming — the coupling that used to be re-derived', () => {
    // The stored value and the selected value differ as raw strings here, which is
    // precisely the case a `===` comparison in the route would have got wrong.
    const decision = resolveUploadDownloadToken(existingWith('  abc-123  '));
    expect(decision).toEqual({ token: 'abc-123', reused: true });
    expect(decision.token).not.toBe(existingWith('  abc-123  ').downloadToken);
  });

  it('reports NO reuse whenever a token is minted (no probe, blank or unusable stored value)', () => {
    for (const existing of [null, existingWith(null), existingWith(''), existingWith('   ')]) {
      const decision = resolveUploadDownloadToken(existing as ExistingUploadObject | null);
      expect(decision.reused).toBe(false);
      expect(decision.token.trim().length).toBeGreaterThan(0);
    }
  });

  it('is the single source of truth behind selectUploadDownloadToken', () => {
    // `selectUploadDownloadToken` is a projection of this decision, so the reused
    // branch cannot drift between the two.
    const stored = existingWith('stored-token');
    expect(selectUploadDownloadToken(stored)).toBe(resolveUploadDownloadToken(stored).token);
  });

  it('is total: a malformed shape degrades to a fresh, not-reused token', () => {
    const hostile: unknown[] = [undefined, {}, { bytes: NaN, downloadToken: 42 }, { bytes: 0, downloadToken: {} }];
    for (const value of hostile) {
      const decision = resolveUploadDownloadToken(value as any);
      expect(decision.reused).toBe(false);
      expect(decision.token.length).toBeGreaterThan(0);
    }
  });
});

describe('buildUploadDownloadUrl', () => {
  it('percent-encodes the object path and embeds the token', () => {
    expect(buildUploadDownloadUrl('bucket-x', 'receipts/acme/fee_77/k_abc_march.pdf', 'tok-1')).toBe(
      'https://firebasestorage.googleapis.com/v0/b/bucket-x/o/receipts%2Facme%2Ffee_77%2Fk_abc_march.pdf?alt=media&token=tok-1'
    );
  });

  it('returns a byte-identical url for a retry that reuses the stored token (Req 4.2)', () => {
    const objectPath = 'chat-files/acme/c_abc/k_0123456789abcdef0123_photo.jpg';

    // Attempt 1: nothing stored yet ⇒ fresh token.
    const firstToken = selectUploadDownloadToken(null);
    const firstUrl = buildUploadDownloadUrl('bucket-x', objectPath, firstToken);

    // Attempt 2 (the retry): the probe finds attempt 1's object and its token.
    const retryToken = selectUploadDownloadToken(existingWith(firstToken));
    const retryUrl = buildUploadDownloadUrl('bucket-x', objectPath, retryToken);

    expect(retryToken).toBe(firstToken);
    expect(retryUrl).toBe(firstUrl);
  });

  it('selects the same token regardless of the client-supplied key that shaped the path (Req 4.4)', () => {
    const stored = existingWith('stored-token');
    const viaKeyA = selectUploadDownloadToken(stored);
    const viaKeyB = selectUploadDownloadToken(stored);
    expect(viaKeyA).toBe('stored-token');
    expect(viaKeyB).toBe('stored-token');
  });
});
