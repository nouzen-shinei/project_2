// Mock Platform as web so the module's guarded native require is skipped and the
// pure URL builder can be imported without the native TurboModule.
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } }));

import {
  buildBackgroundUploadUrl,
  isBackgroundUploadEnabled,
  backgroundUploadDiagnostics,
} from '../../lib/chatBackgroundUpload';

const base = {
  tenantId: 't1',
  conversationFolder: 'c_abc',
  fileName: 'sticker_1.png',
  clientMsgId: 'pm_1',
  recipientId: 'r@example.com',
  mediaKind: 'sticker' as const,
};

describe('buildBackgroundUploadUrl', () => {
  it('targets /storage/upload with createMessage + all message params', () => {
    const u = new URL(buildBackgroundUploadUrl('https://api.example.com', base));
    expect(u.origin + u.pathname).toBe('https://api.example.com/storage/upload');
    expect(u.searchParams.get('tenantId')).toBe('t1');
    expect(u.searchParams.get('purpose')).toBe('chat');
    expect(u.searchParams.get('conversationFolder')).toBe('c_abc');
    expect(u.searchParams.get('filename')).toBe('sticker_1.png');
    expect(u.searchParams.get('createMessage')).toBe('1');
    expect(u.searchParams.get('clientMsgId')).toBe('pm_1');
    expect(u.searchParams.get('recipientId')).toBe('r@example.com');
    expect(u.searchParams.get('mediaKind')).toBe('sticker');
  });

  it('omits messageText unless provided', () => {
    expect(new URL(buildBackgroundUploadUrl('https://api.example.com', base)).searchParams.get('messageText')).toBeNull();
    const withText = new URL(buildBackgroundUploadUrl('https://api.example.com', { ...base, text: 'hi there' }));
    expect(withText.searchParams.get('messageText')).toBe('hi there');
  });

  it('trims a trailing slash on the base url (no double slash)', () => {
    const u = new URL(buildBackgroundUploadUrl('https://api.example.com/', base));
    expect(u.pathname).toBe('/storage/upload');
  });

  it('url-encodes special characters in params', () => {
    const u = new URL(
      buildBackgroundUploadUrl('https://api.example.com', { ...base, recipientId: 'a b@x.com', fileName: 'my file.png' })
    );
    expect(u.searchParams.get('recipientId')).toBe('a b@x.com');
    expect(u.searchParams.get('filename')).toBe('my file.png');
  });

  it('reports background upload disabled on web', () => {
    expect(isBackgroundUploadEnabled()).toBe(false);
  });
});

describe('backgroundUploadDiagnostics', () => {
  it('reports why background upload is disabled on web (module absent, not enabled)', () => {
    const diag = backgroundUploadDiagnostics();
    expect(diag.platform).toBe('web');
    // The guarded native require is skipped on web, so the module never loads.
    expect(diag.moduleLoaded).toBe(false);
    expect(diag.hasStartUpload).toBe(false);
    expect(diag.enabled).toBe(false);
    // Mirrors isBackgroundUploadEnabled()'s result.
    expect(diag.enabled).toBe(isBackgroundUploadEnabled());
  });
});
describe('buildBackgroundUploadUrl uploadKey contract', () => {
  // Sorted [key, value] pairs, so two URLs can be compared independently of param order.
  const paramEntries = (url: string): Array<[string, string]> =>
    [...new URL(url).searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));

  it('includes the uploadKey param with the exact supplied value', () => {
    const u = new URL(buildBackgroundUploadUrl('https://api.example.com', { ...base, uploadKey: 'pm_1_upload_key' }));
    expect(u.searchParams.has('uploadKey')).toBe(true);
    expect(u.searchParams.get('uploadKey')).toBe('pm_1_upload_key');
  });

  it('omits the uploadKey param entirely when no key is supplied', () => {
    // Backward-compat contract: absent, not merely empty/falsy.
    const u = new URL(buildBackgroundUploadUrl('https://api.example.com', base));
    expect(u.searchParams.has('uploadKey')).toBe(false);
    expect([...u.searchParams.keys()]).not.toContain('uploadKey');
  });

  it('leaves every other query param unchanged — the two URLs differ ONLY by uploadKey', () => {
    const params = { ...base, text: 'hi there' };
    const withoutKey = buildBackgroundUploadUrl('https://api.example.com', params);
    const withKey = buildBackgroundUploadUrl('https://api.example.com', { ...params, uploadKey: 'k_stable_123' });

    expect(new URL(withKey).origin + new URL(withKey).pathname).toBe(
      new URL(withoutKey).origin + new URL(withoutKey).pathname
    );

    // Dropping uploadKey from the with-key URL must reproduce the without-key params exactly.
    expect(paramEntries(withKey).filter(([k]) => k !== 'uploadKey')).toEqual(paramEntries(withoutKey));
    // And the only difference is the added uploadKey pair.
    expect(paramEntries(withKey).filter(([k]) => k === 'uploadKey')).toEqual([['uploadKey', 'k_stable_123']]);

    // Spot-check the individual values survive on the with-key URL.
    const u = new URL(withKey);
    expect(u.searchParams.get('tenantId')).toBe('t1');
    expect(u.searchParams.get('purpose')).toBe('chat');
    expect(u.searchParams.get('conversationFolder')).toBe('c_abc');
    expect(u.searchParams.get('filename')).toBe('sticker_1.png');
    expect(u.searchParams.get('createMessage')).toBe('1');
    expect(u.searchParams.get('clientMsgId')).toBe('pm_1');
    expect(u.searchParams.get('recipientId')).toBe('r@example.com');
    expect(u.searchParams.get('mediaKind')).toBe('sticker');
    expect(u.searchParams.get('messageText')).toBe('hi there');
  });

  it('leaves every other query param unchanged when messageText is omitted too', () => {
    const withoutKey = buildBackgroundUploadUrl('https://api.example.com', base);
    const withKey = buildBackgroundUploadUrl('https://api.example.com', { ...base, uploadKey: 'k_stable_123' });

    expect(paramEntries(withKey).filter(([k]) => k !== 'uploadKey')).toEqual(paramEntries(withoutKey));
    expect(new URL(withKey).searchParams.get('messageText')).toBeNull();
  });

  it('url-encodes an unsafe uploadKey so it round-trips to the exact input', () => {
    const unsafeKey = 'k /?#&=+%ü\u00e9 "\'<>[]{}|\\^`:@';
    const raw = buildBackgroundUploadUrl('https://api.example.com', { ...base, uploadKey: unsafeKey });
    const u = new URL(raw);

    // Parsed back through URL/URLSearchParams the value is byte-identical to the input.
    expect(u.searchParams.get('uploadKey')).toBe(unsafeKey);
    expect(new URLSearchParams(u.search).get('uploadKey')).toBe(unsafeKey);
    // The raw query string is encoded, not literal (a bare '#' would truncate the query).
    expect(u.search).not.toContain('#');
    // Encoding the key must not disturb the other params.
    expect(paramEntries(raw).filter(([k]) => k !== 'uploadKey')).toEqual(
      paramEntries(buildBackgroundUploadUrl('https://api.example.com', base))
    );
  });
});

describe('buildBackgroundUploadUrl displayName contract', () => {
  const paramEntries = (url: string): Array<[string, string]> =>
    [...new URL(url).searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));

  it('includes the displayName param with the exact supplied value', () => {
    const u = new URL(
      buildBackgroundUploadUrl('https://api.example.com', { ...base, displayName: 'IMG_0042.jpg' })
    );
    expect(u.searchParams.has('displayName')).toBe(true);
    expect(u.searchParams.get('displayName')).toBe('IMG_0042.jpg');
  });

  it('omits the displayName param entirely when none is supplied', () => {
    // Backward-compat contract: absent, not merely empty — the backend falls back
    // to `filename` for every user-visible name on an absent value.
    const u = new URL(buildBackgroundUploadUrl('https://api.example.com', base));
    expect(u.searchParams.has('displayName')).toBe(false);
    expect([...u.searchParams.keys()]).not.toContain('displayName');
  });

  it('leaves every other query param unchanged — the two URLs differ ONLY by displayName', () => {
    const params = { ...base, text: 'hi there', uploadKey: 'k_stable_123' };
    const without = buildBackgroundUploadUrl('https://api.example.com', params);
    const with_ = buildBackgroundUploadUrl('https://api.example.com', {
      ...params,
      displayName: 'IMG_0042.jpg',
    });

    expect(new URL(with_).origin + new URL(with_).pathname).toBe(
      new URL(without).origin + new URL(without).pathname
    );
    expect(paramEntries(with_).filter(([k]) => k !== 'displayName')).toEqual(paramEntries(without));
    expect(paramEntries(with_).filter(([k]) => k === 'displayName')).toEqual([
      ['displayName', 'IMG_0042.jpg'],
    ]);

    // `filename` is NOT rewritten by supplying a display name: the two carry
    // different jobs (object path vs user-visible label).
    const u = new URL(with_);
    expect(u.searchParams.get('filename')).toBe('sticker_1.png');
    expect(u.searchParams.get('uploadKey')).toBe('k_stable_123');
    expect(u.searchParams.get('tenantId')).toBe('t1');
    expect(u.searchParams.get('purpose')).toBe('chat');
    expect(u.searchParams.get('conversationFolder')).toBe('c_abc');
    expect(u.searchParams.get('createMessage')).toBe('1');
    expect(u.searchParams.get('clientMsgId')).toBe('pm_1');
    expect(u.searchParams.get('recipientId')).toBe('r@example.com');
    expect(u.searchParams.get('mediaKind')).toBe('sticker');
    expect(u.searchParams.get('messageText')).toBe('hi there');
  });

  it('carries a filename and a displayName that differ, independently', () => {
    const u = new URL(
      buildBackgroundUploadUrl('https://api.example.com', {
        ...base,
        fileName: 'pick_pm_1_0k1j2h3g4f5d6s.jpg',
        displayName: 'holiday photo.jpg',
      })
    );
    expect(u.searchParams.get('filename')).toBe('pick_pm_1_0k1j2h3g4f5d6s.jpg');
    expect(u.searchParams.get('displayName')).toBe('holiday photo.jpg');
  });

  it('url-encodes an unsafe displayName so it round-trips to the exact input', () => {
    const unsafe = 'my report /?#&=+% ü "quotes".pdf';
    const raw = buildBackgroundUploadUrl('https://api.example.com', { ...base, displayName: unsafe });
    const u = new URL(raw);
    expect(u.searchParams.get('displayName')).toBe(unsafe);
    expect(u.search).not.toContain('#');
    expect(paramEntries(raw).filter(([k]) => k !== 'displayName')).toEqual(
      paramEntries(buildBackgroundUploadUrl('https://api.example.com', base))
    );
  });
});
