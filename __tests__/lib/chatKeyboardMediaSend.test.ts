import {
  normalizeKeyboardMediaCandidate,
  describeKeyboardMediaRejection,
  resolveKeyboardMediaSendMode,
  KEYBOARD_MEDIA_MAX_BYTES,
} from '../../lib/chatKeyboardMediaSend';

const NOW = 1_700_000_000_000;
const now = () => NOW;

describe('normalizeKeyboardMediaCandidate', () => {
  it('rejects a missing/empty/whitespace uri', () => {
    expect(normalizeKeyboardMediaCandidate(null)).toEqual({ ok: false, reason: 'missing_uri' });
    expect(normalizeKeyboardMediaCandidate({ uri: '' })).toEqual({ ok: false, reason: 'missing_uri' });
    expect(normalizeKeyboardMediaCandidate({ uri: '   ' })).toEqual({ ok: false, reason: 'missing_uri' });
  });

  it('accepts an image and synthesizes a filename + fills both name/size aliases', () => {
    const res = normalizeKeyboardMediaCandidate(
      { uri: 'blob:abc', mimeType: 'image/png', fileSize: 1234 },
      { now }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.file.mimeType).toBe('image/png');
      expect(res.file.fileType).toBe('image/png');
      expect(res.file.fileName).toBe(`keyboard_${NOW}.png`);
      expect(res.file.name).toBe(res.file.fileName);
      expect(res.file.fileSize).toBe(1234);
      expect(res.file.size).toBe(1234);
      expect(res.file.lastModified).toBe(NOW);
    }
  });

  it('normalizes jpeg -> .jpg and quicktime -> .mov extensions', () => {
    const jpg = normalizeKeyboardMediaCandidate({ uri: 'x', mimeType: 'image/jpeg' }, { now });
    expect(jpg.ok && jpg.file.fileName.endsWith('.jpg')).toBe(true);
    const mov = normalizeKeyboardMediaCandidate({ uri: 'x', mimeType: 'video/quicktime' }, { now });
    expect(mov.ok && mov.file.fileName.endsWith('.mov')).toBe(true);
  });

  it('infers the type from the uri when mimeType is absent', () => {
    const res = normalizeKeyboardMediaCandidate(
      { uri: 'file:///tmp/pic.gif' },
      { inferType: () => 'image/gif', now }
    );
    expect(res.ok && res.file.mimeType).toBe('image/gif');
  });

  it('rejects non image/video types (and unknown types with no inference)', () => {
    expect(normalizeKeyboardMediaCandidate({ uri: 'x', mimeType: 'application/pdf' })).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(normalizeKeyboardMediaCandidate({ uri: 'x' })).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(
      normalizeKeyboardMediaCandidate({ uri: 'x' }, { inferType: () => 'application/octet-stream' })
    ).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('rejects media over the size ceiling', () => {
    const res = normalizeKeyboardMediaCandidate({
      uri: 'x',
      mimeType: 'video/mp4',
      fileSize: KEYBOARD_MEDIA_MAX_BYTES + 1,
    });
    expect(res).toEqual({ ok: false, reason: 'too_large' });
  });

  it('accepts media exactly at the ceiling', () => {
    const res = normalizeKeyboardMediaCandidate({
      uri: 'x',
      mimeType: 'video/mp4',
      fileSize: KEYBOARD_MEDIA_MAX_BYTES,
    });
    expect(res.ok).toBe(true);
  });

  it('preserves a provided filename and passes the webFile Blob through', () => {
    const blob = { size: 10, type: 'image/png' } as unknown as Blob;
    const res = normalizeKeyboardMediaCandidate(
      { uri: 'blob:x', mimeType: 'image/png', fileName: 'my pic.png', fileSize: 10, webFile: blob },
      { now }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.file.fileName).toBe('my pic.png');
      expect(res.file.webFile).toBe(blob);
    }
  });

  it('normalizes the paste source and omits it when absent/unknown', () => {
    const kb = normalizeKeyboardMediaCandidate({ uri: 'x', mimeType: 'image/png', source: 'KEYBOARD' }, { now });
    expect(kb.ok && kb.file.source).toBe('keyboard');

    const clip = normalizeKeyboardMediaCandidate({ uri: 'x', mimeType: 'image/png', source: 'clipboard' }, { now });
    expect(clip.ok && clip.file.source).toBe('clipboard');

    const none = normalizeKeyboardMediaCandidate({ uri: 'x', mimeType: 'image/png' }, { now });
    expect(none.ok && 'source' in none.file).toBe(false);

    const unknown = normalizeKeyboardMediaCandidate({ uri: 'x', mimeType: 'image/png', source: 'weird' }, { now });
    expect(unknown.ok && unknown.file.source).toBeUndefined();
  });
});

describe('resolveKeyboardMediaSendMode', () => {
  it('never treats video as a sticker/gif — always preview, even from the keyboard', () => {
    expect(resolveKeyboardMediaSendMode({ mimeType: 'video/mp4', source: 'keyboard' })).toBe('preview');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'video/quicktime' })).toBe('preview');
  });

  it('source "keyboard" → immediate sticker for ANY image format (incl. PNG/JPEG)', () => {
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/png', source: 'keyboard' })).toBe('sticker');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/jpeg', source: 'keyboard' })).toBe('sticker');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/gif', source: 'keyboard' })).toBe('sticker');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/webp', source: 'keyboard' })).toBe('sticker');
  });

  it('source "clipboard" → preview for ANY image format (incl. GIF/WebP)', () => {
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/gif', source: 'clipboard' })).toBe('preview');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/webp', source: 'clipboard' })).toBe('preview');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/png', source: 'clipboard' })).toBe('preview');
  });

  it('unknown source (web/iOS) → format fallback: GIF/WebP immediate, else preview', () => {
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/gif' })).toBe('sticker');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/webp' })).toBe('sticker');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/png' })).toBe('preview');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'image/jpeg' })).toBe('preview');
  });

  it('is case-insensitive on the mime type', () => {
    expect(resolveKeyboardMediaSendMode({ mimeType: 'IMAGE/GIF' })).toBe('sticker');
    expect(resolveKeyboardMediaSendMode({ mimeType: 'Image/PNG' })).toBe('preview');
  });
});

describe('describeKeyboardMediaRejection', () => {
  it('returns distinct, non-empty copy per reason', () => {
    const unsupported = describeKeyboardMediaRejection('unsupported_type');
    const tooLarge = describeKeyboardMediaRejection('too_large');
    const missing = describeKeyboardMediaRejection('missing_uri');
    expect(unsupported.title).toMatch(/unsupported/i);
    expect(tooLarge.title).toMatch(/large/i);
    expect(missing.message.length).toBeGreaterThan(0);
    expect(new Set([unsupported.title, tooLarge.title, missing.title]).size).toBe(3);
  });
});
