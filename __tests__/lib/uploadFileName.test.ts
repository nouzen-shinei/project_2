// Feature: upload-idempotency
// Unit + property tests for lib/uploadFileName.ts (Requirements 1.1, 1.2, 1.4, 7.1, 7.4, 7.7)
//
// Why this file exists: the backend's deterministic chat path is
// `chat-files/{tenantId}/{conversationFolder}/k_{hash(uploadKey)}_{safeName}`
// (`backend-runtime/src/lib/uploadObjectPath.ts`, design.md "Object path formats"),
// so the object's identity is the PAIR (uploadKey, filename). `lib/uploadKey.ts`
// pins the key half; this pins the filename half.

import * as fc from 'fast-check';

import { generatePendingId } from '../../lib/pendingId';
import {
  deriveStableUploadFileName,
  deriveUploadExtension,
} from '../../lib/uploadFileName';
// The REAL backend sanitizer, imported (not reimplemented) so "the derived name
// survives the server untouched" is asserted against the same code the route runs.
// Reachable from the root jest config: `testPathIgnorePatterns` only excludes
// backend-runtime from test DISCOVERY, and the `^.+\.tsx?$` transform applies
// repo-wide, so importing a backend source module from a root test is fine.
import { sanitizeStorageSegment } from '../../backend-runtime/src/lib/uploadObjectPath';

/** What the backend's `sanitizeStorageSegment` leaves untouched. */
const SANITIZER_STABLE = /^[A-Za-z0-9._-]+$/;

/** `{kb|pick}_{id head}_{14-char fingerprint}.{ext}` */
const NAME_SHAPE = /^(kb|pick)_([A-Za-z0-9_-]+)_([0-9a-z]{14})\.([A-Za-z0-9_-]{1,12})$/;

/**
 * The two guarantees every derived name must carry, whatever the input:
 * it is sanitizer-stable (so the client-predicted path is the server-written one)
 * and its id head is non-empty (so a degenerate id cannot produce `kb__abc.png`).
 */
function expectWellFormed(name: string): RegExpMatchArray {
  expect(name).toMatch(SANITIZER_STABLE);
  // The identity check that matters: the server rewrites nothing.
  expect(sanitizeStorageSegment(name)).toBe(name);
  const match = name.match(NAME_SHAPE);
  expect(match).not.toBeNull();
  expect(match![2].length).toBeGreaterThan(0);
  return match!;
}

describe('deriveUploadExtension', () => {
  it('prefers the mime subtype', () => {
    expect(deriveUploadExtension({ mime: 'image/png', uri: 'file:///a/b.jpg' })).toBe('png');
    expect(deriveUploadExtension({ mime: 'video/mp4' })).toBe('mp4');
  });

  it('falls back to the uri extension, stripping query and fragment', () => {
    expect(deriveUploadExtension({ uri: 'file:///a/pic.webp' })).toBe('webp');
    expect(deriveUploadExtension({ mime: '', uri: 'https://x.test/a/pic.webp?token=1' })).toBe('webp');
    expect(deriveUploadExtension({ uri: 'https://x.test/a/pic.gif#frag' })).toBe('gif');
    expect(deriveUploadExtension({ uri: 'https://x.test/a/pic.jpg?v=2#frag' })).toBe('jpg');
  });

  it('returns bin for a dot-less uri rather than the whole uri', () => {
    // `split('.').pop()` returns the ENTIRE string when there is no dot; the
    // length cap is what stops a path-shaped "extension" reaching the object name.
    expect(deriveUploadExtension({ uri: 'content://media/external/images/1000' })).toBe('bin');
    expect(deriveUploadExtension({ uri: 'file:///storage/emulated/0/pic' })).toBe('bin');
  });

  it('sanitizes a mime subtype that is not already path-safe', () => {
    expect(deriveUploadExtension({ mime: 'image/svg+xml' })).toBe('svg_xml');
  });

  it('treats a generic octet-stream subtype as no subtype', () => {
    // Every chat call site falls back to `application/octet-stream` when the picker
    // gives no mime type, and `octet-stream` names no format. Keeping the OS
    // extension here is what preserves the extension arm of the backend's
    // chat-video detection for a picked `.MOV` with an unknown mime — with a generic
    // content type, the `video/*` arm cannot cover for it.
    expect(deriveUploadExtension({ mime: 'application/octet-stream', uri: 'file:///a/IMG_1.MOV' })).toBe('MOV');
    expect(deriveUploadExtension({ mime: 'APPLICATION/OCTET-STREAM', uri: 'file:///a/b.mp4' })).toBe('mp4');
    // Nothing better to fall back to ⇒ still `bin`, never `octet-stream`.
    expect(deriveUploadExtension({ mime: 'application/octet-stream' })).toBe('bin');
  });

  it('returns bin for an implausibly long extension', () => {
    expect(
      deriveUploadExtension({
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    ).toBe('bin');
    expect(deriveUploadExtension({ uri: 'file:///a/b.thisextensioniswaytoolong' })).toBe('bin');
  });

  it('returns bin for blank or absent input', () => {
    expect(deriveUploadExtension({})).toBe('bin');
    expect(deriveUploadExtension({ mime: '', uri: '' })).toBe('bin');
    expect(deriveUploadExtension({ mime: null, uri: null })).toBe('bin');
    expect(deriveUploadExtension({ mime: 'image', uri: '' })).toBe('bin'); // no subtype, no uri
    expect(deriveUploadExtension({ mime: 'image/', uri: '' })).toBe('bin'); // empty subtype
    expect(deriveUploadExtension({ mime: '   ', uri: '   ' })).toBe('bin');
  });
});

describe('deriveStableUploadFileName', () => {
  const base = { stableId: 'pm_1712345678901_abc123', source: 'keyboard', mime: 'image/png' };

  it('is stable across repeated invocations for one pending item', () => {
    const first = deriveStableUploadFileName(base);
    const second = deriveStableUploadFileName(base);
    const third = deriveStableUploadFileName({ ...base });
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('reads neither the clock nor the RNG', () => {
    // The bug this module closes was a `Date.now()` in the filename, so assert the
    // absence directly rather than inferring it from equal outputs.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_712_345_678_901);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const args = { ...base, stableId: 'pm_abc', uri: 'file:///outbox/pm_1.png' };
      const first = deriveStableUploadFileName(args);
      nowSpy.mockReturnValue(1_799_999_999_999);
      randomSpy.mockReturnValue(0.99);
      expect(deriveStableUploadFileName(args)).toBe(first);
      expect(nowSpy).not.toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
      // Nothing timestamp-shaped leaks in from anywhere else either.
      expect(first).not.toMatch(/\d{13}/);
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it('produces a sanitizer-stable name in the documented shape', () => {
    const match = expectWellFormed(deriveStableUploadFileName(base));
    expect(match[1]).toBe('kb');
    expect(match[2]).toBe('pm_1712345678901_abc123');
    expect(match[4]).toBe('png');
  });

  it('marks the source for readability without letting it carry correctness', () => {
    expect(deriveStableUploadFileName({ ...base, source: 'keyboard' }).startsWith('kb_')).toBe(true);
    expect(deriveStableUploadFileName({ ...base, source: 'picker' }).startsWith('pick_')).toBe(true);
    expect(deriveStableUploadFileName({ ...base, source: undefined }).startsWith('pick_')).toBe(true);
  });

  it('gives two different pending items two different names', () => {
    const a = deriveStableUploadFileName({ ...base, stableId: 'pm_1712345678901_aaa' });
    const b = deriveStableUploadFileName({ ...base, stableId: 'pm_1712345678901_bbb' });
    expect(a).not.toBe(b);
  });

  it('keeps ids apart that the backend sanitizer would collapse onto one name', () => {
    // `sanitizeStorageSegment` rewrites `+` to `_`, so a name built by sanitizing
    // alone would give these two ids ONE object. The fingerprint is taken over the
    // RAW id, which is exactly why it exists.
    const plus = deriveStableUploadFileName({ ...base, stableId: 'pm_a+b' });
    const underscore = deriveStableUploadFileName({ ...base, stableId: 'pm_a_b' });
    expect(plus).not.toBe(underscore);
    // Both still land inside the sanitizer's charset, so neither is rewritten.
    expectWellFormed(plus);
    expectWellFormed(underscore);
    // The heads DO collapse — the fingerprints are what differ.
    expect(plus.split('_').slice(0, 3).join('_')).toBe(underscore.split('_').slice(0, 3).join('_'));
  });

  it.each([
    ['a space', 'pm 1712345678901 abc'],
    ['a slash', 'pm/17123/abc'],
    ['a dot', 'pm.1712345678901.abc'],
    ['a percent-encoded traversal', 'pm_%2e%2e%2f_abc'],
    ['a NUL', 'pm_\u0000_abc'],
  ])('survives an id containing %s', (_label, stableId) => {
    expectWellFormed(deriveStableUploadFileName({ ...base, stableId }));
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['very long', `pm_${'x'.repeat(500)}`],
    ['non-ascii', 'ключ_идентификатор'],
    ['emoji', '🙂🙂🙂'],
    ['a bare dot', '.'],
    ['a traversal', '../..'],
  ])('still yields a well-formed name for a %s id', (_label, stableId) => {
    expectWellFormed(deriveStableUploadFileName({ ...base, stableId }));
  });

  it('never collides across real pending ids, and keeps each one readable in full', () => {
    // The call sites in `app/(tabs)/chat.tsx` always pass a `generatePendingId('pm')`
    // value as `stableId`, so pin the guarantee against that actual input shape:
    // 200 distinct items ⇒ 200 distinct object filenames, with the id carried whole
    // (the head cap is 40 chars, a pending id is ~29) so a stored object can be
    // grepped back to its pending item.
    const ids = Array.from({ length: 200 }, () => generatePendingId('pm'));
    const names = ids.map((stableId) =>
      deriveStableUploadFileName({ stableId, source: 'keyboard', mime: 'image/png' })
    );
    expect(new Set(names).size).toBe(200);
    names.forEach((name, index) => {
      expectWellFormed(name);
      expect(name.startsWith(`kb_${ids[index]}_`)).toBe(true);
    });
  });

  it('keeps long ids apart even though the readable head is truncated', () => {
    const head = `pm_${'x'.repeat(500)}`;
    const a = deriveStableUploadFileName({ ...base, stableId: `${head}a` });
    const b = deriveStableUploadFileName({ ...base, stableId: `${head}b` });
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThan(80); // capped, not 500 chars of path segment
  });

  it('ignores surrounding whitespace, so a re-read id still resolves to one object', () => {
    expect(deriveStableUploadFileName({ ...base, stableId: '  pm_abc  ' })).toBe(
      deriveStableUploadFileName({ ...base, stableId: 'pm_abc' })
    );
  });

  it('passes through chatService\'s own client-side filename sanitizer unchanged', () => {
    // `chatService.uploadFile` / `buildChatBackgroundUploadRequest` apply
    // `.replace(/[^a-zA-Z0-9.-]/g, '_')` before the name reaches the query string.
    // `_` maps to `_`, so that pass is the identity on our output too — the name the
    // call site derives is the name the backend sanitizes into the object path.
    const name = deriveStableUploadFileName(base);
    expect(name.replace(/[^a-zA-Z0-9.-]/g, '_')).toBe(name);
  });

  // Feature: upload-idempotency, Property 1: Deterministic paths are retry-stable
  // (client filename half — the resolver half lives in
  // backend-runtime/src/__tests__/uploadObjectPath.pathDerivation.property.test.ts)
  // **Validates: Requirements 1.1, 1.2, 7.4**
  it('Property: one pending item always derives one sanitizer-stable filename', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.constantFrom<string | undefined>('keyboard', 'picker', undefined),
        fc.constantFrom<string | undefined>(
          'image/png',
          'image/gif',
          'image/svg+xml',
          'video/mp4',
          '',
          undefined
        ),
        fc.constantFrom<string | undefined>(
          'file:///outbox/pm_1.png',
          'content://media/external/images/1',
          'https://x.test/a/b.webp?t=1',
          '',
          undefined
        ),
        (stableId, source, mime, uri) => {
          const args = { stableId, source, mime, uri };
          const name = deriveStableUploadFileName(args);
          // Re-deriving on a later attempt (a second "Retry all" tap, the
          // reconnect pass, the resume-on-relaunch pass) targets one object.
          expect(deriveStableUploadFileName(args)).toBe(name);
          expectWellFormed(name);
        }
      ),
      { numRuns: 300 }
    );
  });

  // Feature: upload-idempotency, Property 2: Distinct upload keys produce distinct paths
  // (client filename half — two pending items must never share one object)
  // **Validates: Requirements 1.4, 7.3, 7.7**
  it('Property: distinct pending ids derive pairwise distinct filenames', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ maxLength: 60 }), {
          minLength: 2,
          maxLength: 10,
          // Trim is part of the derivation, so ids that differ only in surrounding
          // whitespace are the SAME item by design and must not be required to differ.
          selector: (id) => id.trim(),
        }),
        fc.constantFrom<string | undefined>('keyboard', 'picker'),
        (ids, source) => {
          const names = ids.map((stableId) =>
            deriveStableUploadFileName({ stableId, source, mime: 'image/png' })
          );
          expect(new Set(names).size).toBe(ids.length);
        }
      ),
      { numRuns: 300 }
    );
  });
});
