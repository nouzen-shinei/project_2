// Feature: upload-idempotency, Task 4.5: share-doc reuse on an idempotent overwrite
//
// Unit coverage for the exported share-token resolution seam `POST /storage/upload`
// uses (Requirements 5.1, 5.2, 5.3, 5.6). Firestore is never touched: the lookup
// and the mint-and-write are injected callbacks, which is exactly how the route
// wires them (`findLatestActiveShareForFile` and the `sharedFiles` doc write).

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import { resolveShareTokenForUpload, type ResolveShareTokenForUploadArgs } from '../app';
import type { StorageUploadPurpose } from '../lib/uploadObjectPath';

const FILE_URL = 'https://firebasestorage.googleapis.com/v0/b/b/o/chat-files%2Facme%2Fc_x%2Fk_abc_p.jpg?alt=media&token=tok-1';

type Harness = {
  args: ResolveShareTokenForUploadArgs;
  lookupCalls: Array<{ tenantId: string; uid: string; fileUrl: string }>;
  createCalls: Array<{ tenantId: string; uid: string; fileUrl: string }>;
};

const harness = (overrides: {
  purpose?: StorageUploadPurpose;
  actorUid?: string | null | undefined;
  isOverwrite?: boolean;
  existingToken?: string | null;
  lookupError?: unknown;
  mintedToken?: string | null;
  createError?: unknown;
} = {}): Harness => {
  const lookupCalls: Harness['lookupCalls'] = [];
  const createCalls: Harness['createCalls'] = [];

  return {
    lookupCalls,
    createCalls,
    args: {
      purpose: overrides.purpose ?? 'chat',
      tenantId: 'acme',
      // `'actorUid' in overrides` rather than `!== undefined`, so an explicitly
      // passed `undefined` (the real absent-uid case) is honored, not defaulted.
      actorUid: 'actorUid' in overrides ? overrides.actorUid : 'uid_123',
      isOverwrite: overrides.isOverwrite ?? false,
      fileUrl: FILE_URL,
      findExistingShareToken: async (input) => {
        lookupCalls.push(input);
        if ('lookupError' in overrides) throw overrides.lookupError;
        return overrides.existingToken ?? null;
      },
      createShareToken: async (input) => {
        createCalls.push(input);
        if ('createError' in overrides) throw overrides.createError;
        return overrides.mintedToken === undefined ? 'minted-token' : overrides.mintedToken;
      },
    },
  };
};

describe('resolveShareTokenForUpload — overwrite reuses the existing share doc', () => {
  it('returns the existing active token and writes no second doc (Req 5.1, 5.2)', async () => {
    const h = harness({ isOverwrite: true, existingToken: 'reused-token' });

    await expect(resolveShareTokenForUpload(h.args)).resolves.toBe('reused-token');

    expect(h.lookupCalls).toEqual([{ tenantId: 'acme', uid: 'uid_123', fileUrl: FILE_URL }]);
    expect(h.createCalls).toHaveLength(0);
  });

  it('mints fresh when the lookup finds no ACTIVE doc — revoked/expired are not reused', async () => {
    // `findLatestActiveShareForFile` filters through `isActiveSharedFileDoc`
    // (revokedAt set, or expiresAt in the past ⇒ skipped) and yields null when no
    // candidate is active, so "revoked or expired" arrives here as exactly this case.
    const h = harness({ isOverwrite: true, existingToken: null });

    await expect(resolveShareTokenForUpload(h.args)).resolves.toBe('minted-token');

    expect(h.lookupCalls).toHaveLength(1);
    expect(h.createCalls).toHaveLength(1);
  });

  it('falls open to minting when the reuse lookup throws (missing index / transient error)', async () => {
    const h = harness({ isOverwrite: true, lookupError: new Error('index missing') });

    await expect(resolveShareTokenForUpload(h.args)).resolves.toBe('minted-token');

    expect(h.createCalls).toHaveLength(1);
  });

  it('ignores a blank token from the lookup rather than returning it', async () => {
    const h = harness({ isOverwrite: true, existingToken: '   ' });

    await expect(resolveShareTokenForUpload(h.args)).resolves.toBe('minted-token');
  });
});

describe('resolveShareTokenForUpload — the legacy (non-overwrite) path is unchanged', () => {
  it('never performs the reuse lookup and mints exactly as today (Req 5.3)', async () => {
    const h = harness({ isOverwrite: false });

    await expect(resolveShareTokenForUpload(h.args)).resolves.toBe('minted-token');

    expect(h.lookupCalls).toHaveLength(0);
    expect(h.createCalls).toEqual([{ tenantId: 'acme', uid: 'uid_123', fileUrl: FILE_URL }]);
  });

  it.each<StorageUploadPurpose>(['chat', 'receipt', 'noticeImage', 'noticeAudio', 'studentProfile'])(
    'mints for the eligible purpose %s',
    async (purpose) => {
      const h = harness({ purpose });
      await expect(resolveShareTokenForUpload(h.args)).resolves.toBe('minted-token');
      expect(h.createCalls).toHaveLength(1);
    }
  );

  it.each<StorageUploadPurpose>(['tenantLogo', 'profilePicture'])(
    'skips the ineligible purpose %s without touching Firestore',
    async (purpose) => {
      const h = harness({ purpose, isOverwrite: true, existingToken: 'reused-token' });
      await expect(resolveShareTokenForUpload(h.args)).resolves.toBeUndefined();
      expect(h.lookupCalls).toHaveLength(0);
      expect(h.createCalls).toHaveLength(0);
    }
  );

  it.each([null, undefined, '', '   '])('returns no token for the unknown actor %p', async (actorUid) => {
    const h = harness({ actorUid: actorUid as any, isOverwrite: true, existingToken: 'reused-token' });
    await expect(resolveShareTokenForUpload(h.args)).resolves.toBeUndefined();
    expect(h.lookupCalls).toHaveLength(0);
    expect(h.createCalls).toHaveLength(0);
  });
});

describe('resolveShareTokenForUpload — failures omit the token, never fail the upload', () => {
  it('resolves undefined when the share doc write throws (Req 5.6)', async () => {
    const h = harness({ createError: new Error('firestore unavailable') });
    await expect(resolveShareTokenForUpload(h.args)).resolves.toBeUndefined();
  });

  it('resolves undefined when minting yields no usable token', async () => {
    for (const minted of [null, '', '   ']) {
      const h = harness({ mintedToken: minted });
      await expect(resolveShareTokenForUpload(h.args)).resolves.toBeUndefined();
    }
  });

  it('resolves undefined when both the lookup and the write throw', async () => {
    const h = harness({ isOverwrite: true, lookupError: new Error('boom'), createError: new Error('boom') });
    await expect(resolveShareTokenForUpload(h.args)).resolves.toBeUndefined();
  });
});
