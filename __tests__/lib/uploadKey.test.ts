// Feature: upload-idempotency
// Unit tests for lib/uploadKey.ts (Requirements 7.4, 7.6)

import * as fc from 'fast-check';

import {
  newUploadKey,
  stableIdForFileIndex,
  uploadKeyForFileIndex,
  uploadKeyFromStableId,
} from '../../lib/uploadKey';

const VALID_KEY = /^[A-Za-z0-9_-]{8,200}$/;

describe('newUploadKey', () => {
  it('produces a key inside the endpoint validation window', () => {
    const key = newUploadKey();
    expect(key).toMatch(VALID_KEY);
  });

  it('keeps an optional prefix for log readability', () => {
    expect(newUploadKey('receipt').startsWith('receipt_')).toBe(true);
  });

  it('sanitizes and caps a hostile or oversized prefix', () => {
    expect(newUploadKey('../a b/c')).toMatch(VALID_KEY);
    expect(newUploadKey('p'.repeat(500))).toMatch(VALID_KEY);
  });

  it('never repeats a value across calls', () => {
    const keys = new Set(Array.from({ length: 500 }, () => newUploadKey('chat')));
    expect(keys.size).toBe(500);
  });

  it('stays valid and unique when crypto.randomUUID is unavailable', () => {
    const originalCrypto = (globalThis as { crypto?: unknown }).crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const keys = new Set(Array.from({ length: 200 }, () => newUploadKey('receipt')));
      expect(keys.size).toBe(200);
      keys.forEach((key) => expect(key).toMatch(VALID_KEY));
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
      });
    }
  });
});

describe('uploadKeyFromStableId', () => {
  it('is deterministic for a given id', () => {
    const id = 'pending_1712345678901_abc123def456';
    expect(uploadKeyFromStableId(id)).toBe(uploadKeyFromStableId(id));
  });

  it('passes a clientMsgId in the safe charset through unchanged', () => {
    const id = 'pending_1712345678901_abc123def456';
    expect(uploadKeyFromStableId(id)).toBe(id);
  });

  it.each([
    ['', 'blank'],
    ['ab', 'too short'],
    ['   ', 'whitespace only'],
    ['x'.repeat(500), 'too long'],
    ['pending/1.2#3', 'illegal characters'],
    ['ключ 🙂', 'non-ascii'],
  ])('normalizes %s (%s) into the validation window', (id) => {
    expect(uploadKeyFromStableId(id)).toMatch(VALID_KEY);
  });

  it('keeps distinct ids distinct even when they share a truncated head', () => {
    const head = 'y'.repeat(400);
    expect(uploadKeyFromStableId(`${head}a`)).not.toBe(uploadKeyFromStableId(`${head}b`));
  });
});

// ---------------------------------------------------------------------------
// uploadKeyForFileIndex: the per-file key for a MULTI-file logical action
// (Requirements 7.1, 7.2, 7.3, 7.6, 7.7).
//
// `chatService.sendMessageWithMultipleFiles` uploads N attachments from ONE
// `clientMsgId`. The backend's deterministic chat path is
// `k_{hash(uploadKey)}_{safeName}`, so N files sharing one key would differ only
// by filename and two same-named attachments would clobber each other — the
// per-index derivation is what keeps them apart.
// ---------------------------------------------------------------------------
describe('uploadKeyForFileIndex', () => {
  it('is deterministic in both the base and the index', () => {
    expect(uploadKeyForFileIndex('pm_1712345678901_abc', 2)).toBe(
      uploadKeyForFileIndex('pm_1712345678901_abc', 2)
    );
  });

  it('produces a distinct key for every index of one base', () => {
    const base = 'pm_1712345678901_abc';
    const keys = new Set(Array.from({ length: 25 }, (_v, index) => uploadKeyForFileIndex(base, index)));
    expect(keys.size).toBe(25);
  });

  it('produces a distinct key set for two different bases', () => {
    const first = Array.from({ length: 5 }, (_v, i) => uploadKeyForFileIndex('pm_action_one', i));
    const second = Array.from({ length: 5 }, (_v, i) => uploadKeyForFileIndex('pm_action_two', i));
    expect(new Set([...first, ...second]).size).toBe(10);
  });

  it('stays inside the endpoint validation window for hostile or oversized bases', () => {
    const bases = ['', '  ', 'a', 'x'.repeat(500), 'pending/1.2#3', 'ключ 🙂'];
    bases.forEach((base) => {
      [0, 1, 9, 42].forEach((index) => {
        expect(uploadKeyForFileIndex(base, index)).toMatch(VALID_KEY);
      });
    });
  });

  it('keeps indices distinct even when the base is long enough to be truncated', () => {
    // The fingerprint is taken over the whole seed, so truncating the head cannot
    // collapse two indices onto one key.
    const base = 'z'.repeat(400);
    const keys = new Set(Array.from({ length: 10 }, (_v, i) => uploadKeyForFileIndex(base, i)));
    expect(keys.size).toBe(10);
  });

  // CONVENTION (deliberate, and the whole point of `stableIdForFileIndex`): file 0
  // IS the single-file key. The native background transport and the chat
  // sticker/GIF path key a single-file send on the bare `clientMsgId`, so index 0
  // has to resolve to that same value or a single-file attachment send would
  // disagree with the background upload of the same send and write a second object.
  // Files 1..N-1 stay distinct from it and from each other.
  it('makes index 0 the single-file key derived from the same id', () => {
    const id = 'pm_1712345678901_abc';
    expect(uploadKeyForFileIndex(id, 0)).toBe(uploadKeyFromStableId(id));
    expect(uploadKeyForFileIndex(id, 1)).not.toBe(uploadKeyFromStableId(id));
  });

  it('agrees with uploadKeyFromStableId(stableIdForFileIndex(...)) for every index', () => {
    // The invariant that keeps the two halves of an object's identity together: the
    // key and the storage filename must both derive from ONE seed.
    const base = 'pm_1712345678901_abc';
    [0, 1, 2, 7].forEach((index) => {
      expect(uploadKeyForFileIndex(base, index)).toBe(
        uploadKeyFromStableId(stableIdForFileIndex(base, index))
      );
    });
  });

  // Feature: upload-idempotency, Property 9: Client retries never re-mint the upload key
  // (derivation half — the transport half lives in
  // __tests__/services/backendStorageUploadResilience.test.ts)
  // **Validates: Requirements 7.2, 7.3, 7.6, 7.7**
  it('Property: per-index keys are deterministic, valid and pairwise distinct', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 50 }), { minLength: 2, maxLength: 8 }),
        (base, indices) => {
          const keys = indices.map((index) => uploadKeyForFileIndex(base, index));

          // Valid for the endpoint, and stable on a second derivation.
          keys.forEach((key, position) => {
            expect(key).toMatch(VALID_KEY);
            expect(key).toBe(uploadKeyForFileIndex(base, indices[position]));
          });

          // Distinct indices of one send never share an object.
          expect(new Set(keys).size).toBe(indices.length);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('stableIdForFileIndex', () => {
  it('returns the trimmed base unchanged for index 0', () => {
    expect(stableIdForFileIndex('  pm_1712345678901_abc  ', 0)).toBe('pm_1712345678901_abc');
  });

  it('suffixes every other index', () => {
    expect(stableIdForFileIndex('pm_1712345678901_abc', 3)).toBe('pm_1712345678901_abc__3');
  });

  it('is deterministic and pairwise distinct across indices', () => {
    const base = 'pm_1712345678901_abc';
    const seeds = Array.from({ length: 12 }, (_v, index) => stableIdForFileIndex(base, index));
    expect(new Set(seeds).size).toBe(12);
    seeds.forEach((seed, index) => expect(seed).toBe(stableIdForFileIndex(base, index)));
  });

  it('tolerates a non-finite or fractional index', () => {
    expect(stableIdForFileIndex('pm_abc', Number.NaN)).toBe('pm_abc');
    expect(stableIdForFileIndex('pm_abc', 2.7)).toBe('pm_abc__2');
  });
});
